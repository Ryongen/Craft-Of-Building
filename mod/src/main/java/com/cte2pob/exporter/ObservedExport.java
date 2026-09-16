package com.cte2pob.exporter;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.robertx22.mine_and_slash.capability.entity.EntityData;
import com.robertx22.mine_and_slash.database.data.stats.IUsableStat;
import com.robertx22.mine_and_slash.database.data.stats.Stat;
import com.robertx22.mine_and_slash.saveclasses.unit.StatData;
import com.robertx22.mine_and_slash.saveclasses.unit.Unit;
import net.minecraft.client.player.LocalPlayer;

import java.util.ArrayList;
import java.util.List;

/**
 * The stat sheet, taken from the server's own finished calculation.
 *
 * This is the half of the export that makes the other half worth having. {@code Unit.toNbt}
 * writes one tag per stat in the container - {@code {i: id, v: value, m: moreMulti}} - and
 * {@code EntityData.addClientNBT} sends that to the owning player, so what is read here is not
 * a client-side recomputation of anything: it is the numbers the server arrived at, the same
 * ones the character screen draws.
 *
 * <h2>What it can and cannot see</h2>
 *
 * Per stat the sync carries the value and the MORE multiplier, and nothing else. So:
 *
 * <ul>
 *   <li>{@code currentValue} and {@code dmgMulti} are read straight off the sync.</li>
 *   <li>{@code usableValue} is computed here by calling the game's own
 *       {@code IUsableStat.getUsableValue} on the game's own {@code Stat} instance, which is
 *       the same call the stat GUI makes. Only the four usable stats have one.</li>
 *   <li>{@code hardcap} and {@code softcap} are properties of the registered stat rather than
 *       of this character, read from the same registry the game just used.</li>
 *   <li>There is no per-source breakdown. The sync has totals only, so a mismatch says which
 *       stat disagrees, never which modifier caused it.</li>
 * </ul>
 */
public final class ObservedExport {

    private ObservedExport() {
    }

    /**
     * {@code Stat.max} defaults to {@code STATICS.MAX_FLOAT}, which the stat GUI prints as
     * {@code Inf}. Recording it as a number would be a decoding rather than a reading, so
     * anything at or above this is left out entirely - exactly what fixtures/README.md asks a
     * human transcriber to do.
     */
    private static final float EFFECTIVELY_INFINITE = 100_000_000f;

    public static JsonObject observed(LocalPlayer player, Warnings warn, String packVersion, String mnsVersion) {
        EntityData en = EntityData.get(player);
        Unit unit = en.getUnit();
        int level = en.getLevel();

        JsonObject observed = new JsonObject();
        observed.addProperty("source", "mod_dump");
        observed.addProperty("capturedAt", Exporter.today());
        observed.addProperty("mineAndSlashVersion", mnsVersion);
        observed.addProperty("packVersion", packVersion);
        observed.addProperty(
                "notes",
                "Read from the synced stat container (Unit.fromNbt) on the client, at character level "
                        + level + ". These are the server's calculated values, not a client recomputation.");

        JsonArray stats = new JsonArray();

        if (unit == null || unit.getStats() == null || unit.getStats().stats.isEmpty()) {
            warn.add("The synced stat container was empty. Mine and Slash syncs it when the data "
                    + "is marked dirty; open your character screen or wait a few seconds after logging "
                    + "in, then export again.");
            observed.add("stats", stats);
            return observed;
        }

        List<StatData> all = new ArrayList<>(unit.getStats().stats.values());
        // Sorted so two exports of the same character diff cleanly.
        all.sort((a, b) -> a.getId().compareTo(b.getId()));

        for (StatData data : all) {
            JsonObject row = new JsonObject();
            row.addProperty("statId", data.getId());
            row.addProperty("currentValue", round(data.getValue()));

            float more = data.getMoreStatTypeMulti();
            // The sheet shows dmg_multi only when it is not 1, and its absence is information:
            // it says the stat is not MULTIPLICATIVE_DAMAGE, or carries no MORE. Recording a 1
            // everywhere would make that distinction invisible.
            if (more != 1f) {
                row.addProperty("dmgMulti", round(more));
            }

            Stat stat = null;
            try {
                stat = data.GetStat();
            } catch (Exception e) {
                warn.add("Stat `" + data.getId() + "` is in your synced container but is not a "
                        + "registered stat on this client. Its value is recorded; its caps are not.");
            }

            if (stat != null) {
                if (stat instanceof IUsableStat usable) {
                    // Exactly the call StatInfoButton makes, then as the percentage the screen
                    // prints: 0.4 becomes 40.
                    float val = usable.getUsableValue(unit, (int) data.getValue(), level) * 100f;
                    row.addProperty("usableValue", round(val));
                }
                if (stat.max < EFFECTIVELY_INFINITE) {
                    row.addProperty("hardcap", round(stat.max));
                }
                if (stat.hasSoftCap()) {
                    row.addProperty("softcap", round(stat.getSoftCap(unit)));
                }
            }

            stats.add(row);
        }

        observed.add("stats", stats);

        // The game's own "where did this come from" breakdown, which names the StatCtxType per
        // contribution. Asked for a few ticks earlier by Cte2PobExporter.
        StatSources.write(observed, warn);

        return observed;
    }

    /**
     * The game calculates in 32-bit floats and the engine in doubles. Printing the float's full
     * decimal expansion would put digits in the file that mean nothing; four decimals is far
     * finer than the 0.005 the fixture runner compares to and drops the noise.
     */
    static double round(float value) {
        return Math.round((double) value * 10000d) / 10000d;
    }
}
