package com.cte2pob.exporter;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonObject;
import net.minecraft.ChatFormatting;
import net.minecraft.client.Minecraft;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.network.chat.Component;
import net.minecraftforge.fml.ModList;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;

/**
 * Puts the pieces together and writes them out.
 *
 * <p>The main file is a complete ground-truth fixture: {@code name}, {@code build} and
 * {@code observed} in exactly the shape {@code fixtures/README.md} describes, with
 * {@code observed.source} set to {@code mod_dump}. Drop it into {@code fixtures/} (or
 * {@code fixtures/local/}, which is git-ignored) and {@code npm run fixtures} will diff the
 * engine against it with no further editing.
 *
 * <p>It also goes to the clipboard, because the common case is pasting it somewhere rather than
 * hunting for the file.
 */
public final class Exporter {

    private static final Gson GSON = new GsonBuilder().setPrettyPrinting().create();
    private static final DateTimeFormatter FILE_STAMP = DateTimeFormatter.ofPattern("yyyy-MM-dd-HHmmss");

    private Exporter() {
    }

    public static void export(Minecraft mc, LocalPlayer player, String packVersion) throws IOException {
        Warnings warn = new Warnings();
        String mnsVersion = modVersion("mmorpg");

        if (packVersion == null || packVersion.isEmpty()) {
            packVersion = "unknown";
            // Nothing on the client knows which pack build is installed - a modpack version is
            // launcher metadata, not game state - and a fixture's whole purpose is to be
            // invalidated by a pack update. So it is asked for rather than invented.
            warn.add("packVersion is \"unknown\". Nothing in game exposes the Craft to Exile 2 version, so "
                    + "pass it yourself with /pobexport \"2.0.2\" or edit the field afterwards. Without it a "
                    + "stale fixture cannot be told from a regression.");
        }

        JsonObject build = BuildExport.build(player, warn, packVersion, mnsVersion);
        JsonObject observed = ObservedExport.observed(player, warn, packVersion, mnsVersion);
        JsonObject raw = RawExport.raw(player, warn);

        int level = build.getAsJsonObject("character").get("level").getAsInt();
        String name = sanitise(player.getGameProfile().getName()) + "-lvl" + level + "-"
                + LocalDateTime.now().format(FILE_STAMP);

        JsonObject fixture = new JsonObject();
        fixture.addProperty("name", name);
        fixture.addProperty("notes", notes(observed, warn));
        fixture.add("build", build);
        fixture.add("observed", observed);

        // Not part of the fixture contract - parseFixture reads the fields it knows and ignores
        // the rest - but provenance belongs in the file rather than in the chat line that scrolls
        // away. Every limitation of this capture is listed here.
        JsonObject exporter = new JsonObject();
        exporter.addProperty("version", Cte2PobExporter.VERSION);
        exporter.addProperty("mineAndSlash", mnsVersion);
        exporter.add("warnings", warn.toJson());
        fixture.add("exporter", exporter);

        String json = GSON.toJson(fixture);

        Path dir = mc.gameDirectory.toPath().resolve("cte2-pob-exports");
        Files.createDirectories(dir);
        Path file = dir.resolve(name + ".json");
        Files.writeString(file, json, StandardCharsets.UTF_8);
        Path rawFile = dir.resolve(name + ".raw.json");
        Files.writeString(rawFile, GSON.toJson(raw), StandardCharsets.UTF_8);

        try {
            mc.keyboardHandler.setClipboard(json);
        } catch (Exception e) {
            warn.add("Could not write to the clipboard: " + e);
        }

        report(player, file, observed, warn);
    }

    private static String notes(JsonObject observed, Warnings warn) {
        int stats = observed.getAsJsonArray("stats").size();
        return "Exported in game by cte2pob-exporter " + Cte2PobExporter.VERSION + ". " + stats
                + " stat(s) read from the synced stat container. " + warn.size()
                + " thing(s) this capture could not do exactly - see `exporter.warnings`.";
    }

    private static void report(LocalPlayer player, Path file, JsonObject observed, Warnings warn) {
        int stats = observed.getAsJsonArray("stats").size();

        player.sendSystemMessage(Component.literal("[PoB] Exported " + stats + " stats + your build")
                .withStyle(ChatFormatting.GREEN));
        player.sendSystemMessage(Component.literal("      " + file).withStyle(ChatFormatting.GRAY));
        player.sendSystemMessage(Component.literal("      copied to clipboard").withStyle(ChatFormatting.GRAY));

        if (warn.size() > 0) {
            player.sendSystemMessage(Component
                    .literal("      " + warn.size() + " warning(s) - listed in the file under exporter.warnings")
                    .withStyle(ChatFormatting.YELLOW));
        }
    }

    private static String modVersion(String modid) {
        try {
            return ModList.get().getModContainerById(modid)
                    .map(c -> c.getModInfo().getVersion().toString())
                    .orElse("unknown");
        } catch (Exception e) {
            return "unknown";
        }
    }

    /** File names end up on disk and in a fixture id, so keep them boring. */
    private static String sanitise(String name) {
        String cleaned = name.replaceAll("[^A-Za-z0-9_-]", "_");
        return cleaned.isEmpty() ? "character" : cleaned;
    }

    public static String today() {
        return LocalDate.now().toString();
    }

    public static String now() {
        return LocalDateTime.now().toString();
    }
}
