package com.cte2pob.exporter;

import com.robertx22.mine_and_slash.database.data.gear_types.bases.SlotFamily;
import com.robertx22.mine_and_slash.saveclasses.item_classes.GearItemData;
import com.robertx22.mine_and_slash.uncommon.datasaving.StackSaving;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.world.item.ItemStack;
import top.theillusivec4.curios.api.CuriosApi;
import top.theillusivec4.curios.api.type.capability.ICuriosItemHandler;
import top.theillusivec4.curios.api.type.inventory.ICurioStacksHandler;
import top.theillusivec4.curios.api.type.inventory.IDynamicStackHandler;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * Every stack the character is wearing, with a label saying where it came from.
 *
 * <p>The labels are not decoration: they are what a warning points at when an item cannot be
 * fully described, so they have to identify the piece without needing the item's name.
 *
 * <p>Only vanilla accessors are used for the vanilla slots - {@code getArmorSlots},
 * {@code getMainHandItem}, {@code getOffhandItem} - rather than reaching into an inventory
 * field. The Mine and Slash jar this compiles against has SRG names for methods it inherits
 * from vanilla, so going through the vanilla types keeps the compile honest and the
 * reobfuscated call correct at runtime.
 */
public final class Equipment {

    private Equipment() {
    }

    public record Slot(String label, ItemStack stack) {
    }

    public static List<Slot> equipped(LocalPlayer player, Warnings warn) {
        List<Slot> slots = new ArrayList<>();

        slots.add(new Slot("mainhand", player.getMainHandItem()));
        slots.add(new Slot("offhand", player.getOffhandItem()));

        int i = 0;
        for (ItemStack stack : player.getArmorSlots()) {
            slots.add(new Slot("armor[" + i + "]", stack));
            i++;
        }

        curios(player, slots, warn);
        heldWeapons(player, warn);
        return slots;
    }

    /**
     * Says which hotbar slot the exported mainhand came from, and names any other weapon on the
     * bar.
     *
     * <p>{@code getMainHandItem()} returns whatever slot is <em>selected</em>, which is a fact
     * about where the mouse wheel happens to be rather than about the character. A player who
     * keeps a scythe in slot 1 and a sword in slot 2 exports the scythe - and if the hits being
     * checked against that export were swung with the sword, then every absolute number in the
     * comparison (base damage, flat damage, the whole weapon contribution) describes an item the
     * build document does not contain. It looks exactly like an engine bug. It cost a session.
     *
     * <p>This does not guess which weapon was meant, because it cannot: both are legitimately
     * the character's. It names them, which is all somebody needs to notice at once.
     */
    private static void heldWeapons(LocalPlayer player, Warnings warn) {
        int selected;
        try {
            selected = player.getInventory().selected;
        } catch (Throwable e) {
            return;
        }

        List<String> others = new ArrayList<>();
        for (int slot = 0; slot < 9; slot++) {
            if (slot == selected) {
                continue;
            }
            ItemStack stack;
            try {
                stack = player.getInventory().getItem(slot);
            } catch (Throwable e) {
                continue;
            }
            if (stack == null || stack.isEmpty() || !isWeapon(stack)) {
                continue;
            }
            others.add("slot " + (slot + 1) + ": " + stack.getHoverName().getString());
        }
        if (others.isEmpty()) {
            return;
        }

        warn.add("The mainhand in this export is hotbar slot " + (selected + 1) + " - the export reads the "
                + "item you are holding, not \"your weapon\". The bar also holds " + others.size()
                + " other weapon(s): " + String.join("; ", others) + ". If the numbers you are checking "
                + "this capture against were made with one of those, re-export with it in hand. Nothing "
                + "else in this file would tell you the two differ.");
    }

    /**
     * Whether a stack is a Mine and Slash weapon or offhand.
     *
     * <p>Decided by the {@code mmorpg_gear_slot} family its base gear type points at, which is
     * the game's own answer - {@code SlotFamily.Weapon} covers the eleven weapon slots and
     * {@code OffHand} the shield, tome and totem. An offhand counts because swapping one changes
     * the character's stats exactly as swapping a sword does.
     *
     * <p>Anything unreadable is not a weapon. A warning that throws while deciding whether to
     * warn would be worse than the problem it is reporting.
     */
    private static boolean isWeapon(ItemStack stack) {
        try {
            if (!StackSaving.GEARS.has(stack)) {
                return false;
            }
            GearItemData gear = StackSaving.GEARS.loadFrom(stack);
            if (gear == null) {
                return false;
            }
            SlotFamily fam = gear.GetBaseGearType().getGearSlot().fam;
            return fam == SlotFamily.Weapon || fam == SlotFamily.OffHand;
        } catch (Throwable e) {
            return false;
        }
    }

    /**
     * Rings, necklaces, the omen and anything another mod added a slot for. Curios keeps its
     * inventory on the player as a capability and syncs it to the owning client so the Curios
     * screen can draw it, so this reads it the same way any client-side renderer would.
     */
    private static void curios(LocalPlayer player, List<Slot> slots, Warnings warn) {
        Optional<ICuriosItemHandler> maybe;
        try {
            maybe = CuriosApi.getCuriosInventory(player).resolve();
        } catch (Throwable e) {
            warn.add("Curios is installed but its inventory could not be read (" + e + "), so rings, "
                    + "necklaces and the omen are missing from this export.");
            return;
        }
        if (maybe.isEmpty()) {
            warn.add("No Curios inventory on this player, so rings, necklaces and the omen are missing "
                    + "from this export.");
            return;
        }

        for (Map.Entry<String, ICurioStacksHandler> entry : maybe.get().getCurios().entrySet()) {
            ICurioStacksHandler handler = entry.getValue();
            if (handler == null) {
                continue;
            }
            IDynamicStackHandler stacks = handler.getStacks();
            if (stacks == null) {
                continue;
            }
            for (int slot = 0; slot < stacks.getSlots(); slot++) {
                ItemStack stack = stacks.getStackInSlot(slot);
                if (!stack.isEmpty()) {
                    slots.add(new Slot("curio:" + entry.getKey() + "[" + slot + "]", stack));
                }
            }
        }
    }
}
