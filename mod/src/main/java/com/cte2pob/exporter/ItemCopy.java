package com.cte2pob.exporter;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonObject;
import com.robertx22.mine_and_slash.database.data.omen.OmenData;
import com.robertx22.mine_and_slash.saveclasses.item_classes.GearItemData;
import com.robertx22.mine_and_slash.saveclasses.jewel.JewelItemData;
import com.robertx22.mine_and_slash.saveclasses.skill_gem.SkillGemData;
import com.robertx22.mine_and_slash.uncommon.datasaving.StackSaving;
import net.minecraft.ChatFormatting;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.client.gui.screens.inventory.AbstractContainerScreen;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.network.chat.Component;
import net.minecraft.world.inventory.Slot;
import net.minecraft.world.item.ItemStack;
import org.lwjgl.glfw.GLFW;

/**
 * One item to the clipboard, in the shape the planner's importer reads.
 *
 * <h2>Why this exists at all</h2>
 *
 * <p>The planner could already read an item's NBT, and in practice nobody could produce any:
 * {@code /data get entity @s SelectedItem} is permission level 2 and is refused on any server
 * where you are not an operator, and vanilla has no way to copy a tooltip. So "try this jewel in
 * the planner" meant exporting an entire character or typing four affixes, four tiers and four
 * roll percents in by hand - and the roll percent is a number no player can read anywhere.
 *
 * <p>Everything needed is already on this client, for the same reason the character export works:
 * the client cannot draw a tooltip for an item whose saved data it does not have. So this reads
 * the stack in your hand, or under your mouse, and writes it out. It sends no packet, runs no
 * command and asks the server for nothing.
 *
 * <h2>What it copies</h2>
 *
 * <p>Five kinds, keyed by which {@code StackSaving} saver the stack carries - which is also what
 * the game itself branches on, so an item that is not one of these is not a Mine and Slash item
 * at all:
 *
 * <table border="1">
 *   <tr><th>Tag</th><th>Kind</th><th>Where it lands in the planner</th></tr>
 *   <tr><td>{@code mmorpg_gear}</td><td>{@code gear}</td><td>a gear slot, or the item pool</td></tr>
 *   <tr><td>{@code mmorpg_jewel}</td><td>{@code jewel}</td><td>the jewel list</td></tr>
 *   <tr><td>{@code mmorpg_omen}</td><td>{@code omen}</td><td>the omen, of which there is one</td></tr>
 *   <tr><td>{@code mmorpg_skill_gem}</td><td>{@code skill} / {@code support} / {@code aura}</td>
 *       <td>the skill bar, a skill's links, or the Augments</td></tr>
 * </table>
 *
 * <p>A skill gem is all three of the last: {@code SkillGemData.type} is {@code SKILL},
 * {@code SUPPORT} or {@code AURA}, and to a player those are three unrelated things - a Skill, a
 * support gem and an Augment - so the copy says which one it is rather than making the planner
 * guess from the id.
 *
 * <p>The payload is an envelope, not a bare item, because five shapes arriving down one paste box
 * need to say which they are:
 *
 * <pre>
 * { "cob": "item", "kind": "jewel", "exporter": "0.4.0",
 *   "name": "Viridian Jewel", "data": { ...the document's own shape... } }
 * </pre>
 */
public final class ItemCopy {

    private static final Gson GSON = new GsonBuilder().setPrettyPrinting().create();

    /** The chord, checked directly rather than through a {@code KeyMapping} - see {@link #chord}. */
    private static final int KEY = GLFW.GLFW_KEY_C;

    private ItemCopy() {
    }

    /**
     * Ctrl+Shift+C, tested against the raw key and modifier bits.
     *
     * <p>A Forge {@code KeyMapping} carries at most one {@code KeyModifier}, so a two-modifier
     * chord cannot be expressed as one and would have to be split into a binding plus a hand-rolled
     * check anyway. Doing the whole check by hand keeps it in one place and keeps it away from
     * Mine and Slash's own bindings: the pack puts the spell hotbar on R, F, C and V, and those are
     * bare keys, so a press with Ctrl and Shift held does not match any of them.
     */
    public static boolean chord(int key, int modifiers) {
        return key == KEY
                && (modifiers & GLFW.GLFW_MOD_CONTROL) != 0
                && (modifiers & GLFW.GLFW_MOD_SHIFT) != 0;
    }

    /**
     * The item the chord means: whatever is under the mouse in an open container screen, and
     * otherwise whatever is in your main hand.
     *
     * <p>Both, because both are how you look at an item. Deciding which jewel to plan around
     * happens with the inventory open and the mouse over it; deciding about the sword you are
     * carrying happens in the world.
     */
    public static ItemStack target(Minecraft mc) {
        Screen screen = mc.screen;
        if (screen instanceof AbstractContainerScreen<?> container) {
            Slot slot = container.getSlotUnderMouse();
            if (slot != null && !slot.getItem().isEmpty()) {
                return slot.getItem();
            }
        }
        return mc.player == null ? ItemStack.EMPTY : mc.player.getMainHandItem();
    }

    /** Copies {@link #target}, and says in chat what it found - including when it found nothing. */
    public static void copy(Minecraft mc) {
        LocalPlayer player = mc.player;
        if (player == null) {
            return;
        }

        ItemStack stack = target(mc);
        if (stack.isEmpty()) {
            say(player, "Nothing under the mouse and nothing in hand.", ChatFormatting.GRAY);
            return;
        }

        JsonObject envelope;
        try {
            envelope = envelope(stack);
        } catch (Exception e) {
            say(player, "That item's saved data could not be read: " + e, ChatFormatting.RED);
            return;
        }

        if (envelope == null) {
            say(player, stack.getHoverName().getString()
                    + " carries no Mine and Slash data, so there is nothing to plan with.",
                    ChatFormatting.GRAY);
            return;
        }

        try {
            mc.keyboardHandler.setClipboard(GSON.toJson(envelope));
        } catch (Exception e) {
            say(player, "Could not write to the clipboard: " + e, ChatFormatting.RED);
            return;
        }

        say(player, "Copied " + envelope.get("kind").getAsString() + ": "
                + envelope.get("name").getAsString() + " - paste it into the planner's Import.",
                ChatFormatting.GREEN);
    }

    /** {@code null} when the stack is not a Mine and Slash item, which is not an error. */
    static JsonObject envelope(ItemStack stack) {
        JsonObject data;
        String kind;

        if (StackSaving.GEARS.has(stack)) {
            GearItemData gear = StackSaving.GEARS.loadFrom(stack);
            if (gear == null) {
                return null;
            }
            // The one kind that needs more than its saved data: base rolls are per entry of the
            // base type's `base_stats`, the runeword's roll is private, and quality is kept apart
            // from the roll it is added to. GearExport knows all three.
            Warnings warn = new Warnings();
            data = GearExport.item(stack, gear, warn, "copied item");
            kind = "gear";
            if (warn.size() > 0) {
                data.add("exporterWarnings", warn.toJson());
            }
        } else if (StackSaving.JEWEL.has(stack)) {
            JewelItemData jewel = StackSaving.JEWEL.loadFrom(stack);
            if (jewel == null) {
                return null;
            }
            data = ItemDoc.jewel(jewel);
            kind = "jewel";
        } else if (StackSaving.OMEN.has(stack)) {
            OmenData omen = StackSaving.OMEN.loadFrom(stack);
            if (omen == null || omen.id == null || omen.id.isEmpty()) {
                return null;
            }
            data = ItemDoc.omen(omen);
            kind = "omen";
        } else if (StackSaving.SKILL_GEM.has(stack)) {
            SkillGemData gem = StackSaving.SKILL_GEM.loadFrom(stack);
            if (gem == null || gem.id == null || gem.id.isEmpty()) {
                return null;
            }
            switch (gem.type) {
                case SUPPORT -> {
                    data = ItemDoc.supportGem(gem);
                    kind = "support";
                }
                case AURA -> {
                    data = ItemDoc.aura(gem);
                    kind = "aura";
                }
                default -> {
                    data = ItemDoc.skill(gem);
                    kind = "skill";
                }
            }
        } else {
            return null;
        }

        JsonObject envelope = new JsonObject();
        envelope.addProperty("cob", "item");
        envelope.addProperty("exporter", Cte2PobExporter.VERSION);
        envelope.addProperty("kind", kind);
        // The name is for the person reading the paste box, not for the importer: it is what the
        // game called the item, so a paste that turns out to be the wrong jewel says so up front.
        envelope.addProperty("name", stack.getHoverName().getString());
        envelope.add("data", data);
        return envelope;
    }

    private static void say(LocalPlayer player, String message, ChatFormatting colour) {
        player.sendSystemMessage(Component.literal("[PoB] " + message).withStyle(colour));
    }
}
