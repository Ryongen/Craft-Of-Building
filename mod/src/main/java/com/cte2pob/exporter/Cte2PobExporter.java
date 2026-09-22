package com.cte2pob.exporter;

import com.mojang.brigadier.builder.LiteralArgumentBuilder;
import com.mojang.brigadier.arguments.StringArgumentType;
import net.minecraft.client.Minecraft;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.network.chat.Component;
import net.minecraftforge.api.distmarker.Dist;
import net.minecraftforge.client.event.InputEvent;
import net.minecraftforge.client.event.RegisterKeyMappingsEvent;
import net.minecraftforge.client.event.RegisterClientCommandsEvent;
import net.minecraftforge.client.event.ScreenEvent;
import net.minecraftforge.event.TickEvent;
import net.minecraftforge.eventbus.api.SubscribeEvent;
import net.minecraftforge.fml.common.Mod;
import org.lwjgl.glfw.GLFW;

/**
 * A client-only exporter for Craft to Exile 2 characters.
 *
 * <h2>Why this can work at all</h2>
 *
 * Every number it writes is already on this client. Mine and Slash sends the player their own
 * data because the client has to draw it:
 *
 * <ul>
 *   <li>{@code PlayerData.syncData} serialises the whole capability - talents, stat points,
 *       spell schools, the gem and aura inventories, jewels - and sends it to the owning
 *       player. That is what the talent and character screens render from.</li>
 *   <li>{@code EntityData.addClientNBT} calls {@code UnitNbt.Save} for players, which writes
 *       every entry of the calculated {@code StatContainer} as {@code {i, v, m}}. That is the
 *       server's own finished stat sheet, not a reconstruction of it.</li>
 *   <li>Gear lives in each {@code ItemStack}'s own NBT under {@code mmorpg_gear}
 *       ({@code StackSaving.GEARS}), which the client must have to build a tooltip at all -
 *       {@code GearItemData.BuildTooltip} is {@code @OnlyIn(Dist.CLIENT)}.</li>
 * </ul>
 *
 * So this mod runs no commands and reads what your client was already given, which is why it
 * works on a multiplayer server where {@code /data get entity @s SelectedItem} is refused at
 * permission level 2.
 *
 * <p>It sends exactly one packet, and only one: {@code RequestStatCalcInfoPacket}, to fetch the
 * per-context stat breakdown that {@code /mine_and_slash list_stat_sources} prints.
 * {@code PlayerData.ctxs} is {@code transient} and built server-side, so it is the one thing
 * genuinely not on the client. That packet has no permission check and is the same one the
 * game's own stat screen sends, so the property that matters is intact - this still needs no
 * operator level. See {@link StatSources}.
 *
 * <h2>What it will not do</h2>
 *
 * It records only what it can read. Anything it cannot map onto the build document is named in
 * {@code exporter.warnings} rather than guessed at, because a fixture containing an invented
 * number is worse than no fixture: it agrees with the engine whether or not the engine is right.
 * {@code /cobexport raw} additionally dumps every equipped stack's untranslated NBT beside the
 * fixture, for a character that would be expensive to capture twice.
 */
@Mod(Cte2PobExporter.MODID)
public class Cte2PobExporter {

    public static final String MODID = "craftofbuilding";
    public static final String VERSION = "0.4.0";

    public Cte2PobExporter() {
        // Nothing to do on a server, and nothing here may touch a client class on one.
        // The two subscriber classes below are Dist.CLIENT gated, which is what keeps this
        // loadable in a server jar scan even though it is only ever useful on a client.
    }

    @Mod.EventBusSubscriber(modid = MODID, value = Dist.CLIENT, bus = Mod.EventBusSubscriber.Bus.MOD)
    public static class ModBus {
        @SubscribeEvent
        public static void onRegisterKeys(RegisterKeyMappingsEvent event) {
            event.register(ExportKeys.EXPORT);
        }
    }

    @Mod.EventBusSubscriber(modid = MODID, value = Dist.CLIENT, bus = Mod.EventBusSubscriber.Bus.FORGE)
    public static class ForgeBus {

        @SubscribeEvent
        public static void onClientTick(TickEvent.ClientTickEvent event) {
            if (event.phase != TickEvent.Phase.END) {
                return;
            }
            // consumeClick drains the queued presses, so holding the key exports once.
            boolean pressed = false;
            while (ExportKeys.EXPORT.consumeClick()) {
                pressed = true;
            }
            if (pressed) {
                run(null, false);
            }

            // The stat-source breakdown is a round trip (see StatSources), so an export is
            // requested first and written a few ticks later once the reply has landed. If it
            // never does, the export still happens and says so - a fixture without the
            // breakdown is worth far more than no fixture.
            if (pendingTicks > 0 && --pendingTicks == 0) {
                String version = pendingPackVersion;
                boolean raw = pendingRaw;
                pendingPackVersion = null;
                pendingRaw = false;
                write(version, raw);
            }
        }

        /** Ticks left before the deferred export fires. 0 means nothing is pending. */
        private static int pendingTicks = 0;
        private static String pendingPackVersion = null;
        private static boolean pendingRaw = false;

        static void schedule(String packVersion, boolean raw) {
            pendingPackVersion = packVersion;
            pendingRaw = raw;
            // ~10 ticks is half a second, which is ample for a local server and forgiving on a
            // remote one. The cost of waiting is nothing; the cost of writing too early is a
            // fixture missing the breakdown.
            pendingTicks = 10;
        }

        /**
         * Ctrl+Shift+C over an item in any container screen: copy that item for the planner.
         *
         * <p>`Pre` and cancelled on a hit, so the chord never reaches the screen underneath. Most
         * screens ignore an unknown key, but a search box does not, and typing a C into the JEI
         * filter every time you copy an item would be a small permanent annoyance.
         */
        @SubscribeEvent
        public static void onScreenKey(ScreenEvent.KeyPressed.Pre event) {
            if (ItemCopy.chord(event.getKeyCode(), event.getModifiers())) {
                ItemCopy.copy(Minecraft.getInstance());
                event.setCanceled(true);
            }
        }

        /** The same chord with no screen open, which copies what you are holding. */
        @SubscribeEvent
        public static void onKey(InputEvent.Key event) {
            if (event.getAction() == GLFW.GLFW_PRESS && ItemCopy.chord(event.getKey(), event.getModifiers())) {
                ItemCopy.copy(Minecraft.getInstance());
            }
        }

        /**
         * A client command, registered through {@link RegisterClientCommandsEvent}, so it is
         * dispatched by this client and never reaches the server. That matters: the point of
         * the mod is that it needs no permission, and a server-side command would need one.
         */
        @SubscribeEvent
        public static void onRegisterCommands(RegisterClientCommandsEvent event) {
            LiteralArgumentBuilder<CommandSourceStack> root = LiteralArgumentBuilder
                    .<CommandSourceStack>literal("cobexport")
                    .executes(ctx -> {
                        run(null, false);
                        return 1;
                    })
                    // `raw` asks for the NBT sidecar as well. It used to be written every time;
                    // see Exporter's class comment for why it is opt-in now.
                    .then(LiteralArgumentBuilder.<CommandSourceStack>literal("raw")
                            .executes(ctx -> {
                                run(null, true);
                                return 1;
                            }))
                    .then(com.mojang.brigadier.builder.RequiredArgumentBuilder
                            .<CommandSourceStack, String>argument("packVersion", StringArgumentType.string())
                            .executes(ctx -> {
                                run(StringArgumentType.getString(ctx, "packVersion"), false);
                                return 1;
                            })
                            .then(LiteralArgumentBuilder.<CommandSourceStack>literal("raw")
                                    .executes(ctx -> {
                                        run(StringArgumentType.getString(ctx, "packVersion"), true);
                                        return 1;
                                    })));
            event.getDispatcher().register(root);
        }
    }

    /**
     * @param packVersion the Craft to Exile 2 version this character is playing, if the player
     *                    told us. Nothing on the client knows it - the modpack version is not
     *                    exposed to the game - so it is left as {@code "unknown"} and warned
     *                    about rather than filled in with something plausible.
     */
    public static void run(String packVersion, boolean raw) {
        if (Minecraft.getInstance().player == null) {
            return;
        }
        // Ask for the stat-source breakdown, then write once the reply has had time to land.
        StatSources.request();
        ForgeBus.schedule(packVersion, raw);
    }

    /** The export itself, a few ticks after {@link #run}. */
    static void write(String packVersion, boolean raw) {
        Minecraft mc = Minecraft.getInstance();
        LocalPlayer player = mc.player;
        if (player == null) {
            return;
        }
        try {
            Exporter.export(mc, player, packVersion, raw);
        } catch (Throwable e) {
            // A failed export must never take the client with it.
            player.sendSystemMessage(Component.literal("§c[PoB] Export failed: " + e));
            org.slf4j.LoggerFactory.getLogger(MODID).error("Export failed", e);
        }
    }
}
