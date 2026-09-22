package com.cte2pob.exporter;

import com.mojang.blaze3d.platform.InputConstants;
import net.minecraft.client.KeyMapping;
import net.minecraftforge.client.settings.KeyConflictContext;
import org.lwjgl.glfw.GLFW;

public final class ExportKeys {

    private ExportKeys() {
    }

    /**
     * F6 by default. Vanilla leaves it unbound, and Mine and Slash's own keybinds
     * ({@code KeybindsRegister}) take H, B, P, F1, minus, equals and R/F/C/V for the spell
     * hotbar, so this collides with nothing in the pack out of the box. Rebindable in Controls
     * like any other key.
     */
    public static final KeyMapping EXPORT = new KeyMapping(
            "key.craftofbuilding.export",
            KeyConflictContext.IN_GAME,
            InputConstants.Type.KEYSYM,
            GLFW.GLFW_KEY_F6,
            "key.categories.craftofbuilding");
}
