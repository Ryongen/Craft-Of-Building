package com.cte2pob.exporter;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.world.item.ItemStack;

/**
 * The sidecar: everything the export read, before any of it was mapped onto a build document.
 *
 * <p>This exists so that a capture never has to be taken twice. The mapping in
 * {@link BuildExport} and {@link GearExport} is the part most likely to be wrong or incomplete
 * today - it is new, and the build document has no field for several things the game holds - so
 * the raw form is written alongside it. When the mapping improves, old captures can be
 * re-derived from this file instead of re-farmed in game.
 *
 * <p>Each item's tag is the same NBT that {@code /data get entity @s SelectedItem} would print
 * for an operator, which also makes this file a direct input for the app's item importer.
 */
public final class RawExport {

    private RawExport() {
    }

    public static JsonObject raw(LocalPlayer player, Warnings warn) {
        JsonObject raw = new JsonObject();
        raw.addProperty("exporterVersion", Cte2PobExporter.VERSION);
        raw.addProperty("player", player.getGameProfile().getName());
        raw.addProperty("capturedAt", Exporter.now());

        JsonArray items = new JsonArray();
        for (Equipment.Slot slot : Equipment.equipped(player, new Warnings())) {
            if (slot.stack().isEmpty()) {
                continue;
            }
            JsonObject entry = new JsonObject();
            entry.addProperty("slot", slot.label());
            entry.addProperty("item", itemId(slot.stack()));
            try {
                CompoundTag saved = slot.stack().save(new CompoundTag());
                entry.addProperty("nbt", saved.toString());
            } catch (Exception e) {
                entry.addProperty("nbt", "");
                warn.add(slot.label() + ": raw NBT could not be serialised (" + e + ").");
            }
            items.add(entry);
        }
        raw.add("equipped", items);

        return raw;
    }

    private static String itemId(ItemStack stack) {
        try {
            return net.minecraftforge.registries.ForgeRegistries.ITEMS.getKey(stack.getItem()).toString();
        } catch (Exception e) {
            return "";
        }
    }
}
