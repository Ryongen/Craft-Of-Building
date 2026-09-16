package com.cte2pob.exporter;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.robertx22.library_of_exile.main.Packets;
import com.robertx22.mine_and_slash.gui.screens.stat_gui.RequestStatCalcInfoPacket;
import com.robertx22.mine_and_slash.gui.screens.stat_gui.StatCalcInfoData;
import com.robertx22.mine_and_slash.saveclasses.ExactStatData;
import com.robertx22.mine_and_slash.saveclasses.unit.stat_ctx.SimpleStatCtx;

/**
 * The game's own answer to "where did this stat come from".
 *
 * <p>This is what {@code /mine_and_slash list_stat_sources <stat>} prints, taken as structured
 * data instead of chat lines. Its value is that it names the {@code StatCtxType} a contribution
 * belongs to - GEAR, AURA, TALENT, PASSIVES, BASE_STAT - which is precisely the thing that is
 * hardest to work out from the outside. A stat that disagrees with the engine goes from "search
 * every registry for anything that grants it" to one line.
 *
 * <p>It is the one thing in this mod that is not already on the client.
 * {@code PlayerData.ctxs} is {@code transient} and built server-side in {@code StatCalculation},
 * so it has to be asked for:
 *
 *     public void onReceived(ExilePacketContext ctx) {
 *         Packets.sendToClient(ctx.getPlayer(), new SendStatCalcInfoToClientPacket(Load.player(ctx.getPlayer()).ctxs));
 *     }
 *
 * — RequestStatCalcInfoPacket, which has no permission check and is the same packet the game's
 * own stat screen sends. So the property that matters is kept: this still needs no operator
 * level and works on a server where {@code /data get} is refused. What it costs is a round
 * trip, which is why {@link Cte2PobExporter} asks a few ticks before it writes.
 */
public final class StatSources {

    private StatSources() {
    }

    /** Ask the server for the breakdown. The reply lands in {@code CLIENT_SYNCED}. */
    public static void request() {
        try {
            Packets.sendToServer(new RequestStatCalcInfoPacket());
        } catch (Throwable e) {
            // Never let this take the export down: the fixture is useful without it.
        }
    }

    /**
     * Every contribution the server recorded, flattened.
     *
     * <p>One row per stat per context rather than a nested shape, because that is how it is
     * read: filtered to one stat id and compared against the engine's contexts for the same
     * stat. {@code slot} is only set for gear.
     */
    public static void write(JsonObject observed, Warnings warn) {
        StatCalcInfoData data = StatCalcInfoData.CLIENT_SYNCED;
        if (data == null || data.list == null || data.list.isEmpty()) {
            warn.add("The server did not send a stat-source breakdown in time, so `observed.sources` "
                    + "is missing. The fixture is still valid - this only costs you the game's own "
                    + "answer for which context each stat came from. Try again; it is a round trip.");
            return;
        }

        JsonArray rows = new JsonArray();
        for (SimpleStatCtx ctx : data.list) {
            if (ctx == null || ctx.stats == null) {
                continue;
            }
            for (ExactStatData stat : ctx.stats) {
                if (stat == null) {
                    continue;
                }
                JsonObject row = new JsonObject();
                try {
                    row.addProperty("statId", stat.getStatId());
                    row.addProperty("ctx", ctx.type == null ? "" : ctx.type.name());
                    if (ctx.gear_slot != null && !ctx.gear_slot.isEmpty()) {
                        row.addProperty("slot", ctx.gear_slot);
                    }
                    row.addProperty("type", stat.getType() == null ? "" : stat.getType().name());
                    row.addProperty("value", ObservedExport.round(stat.getValue()));
                } catch (Exception e) {
                    continue;
                }
                rows.add(row);
            }
        }

        if (rows.size() > 0) {
            observed.add("sources", rows);
        } else {
            // The reply arrived and carried nothing this could use. Silence here was wrong: a
            // fixture with no `sources` is indistinguishable from one whose breakdown was never
            // asked for, and the runner's per-stat "game said / engine said" listing quietly
            // stops working with nothing saying why.
            warn.add("The server's stat-source breakdown arrived empty, so `observed.sources` is "
                    + "missing. The fixture is still valid - this only costs the game's own answer "
                    + "for which context each stat came from, which is what a mismatch is "
                    + "diagnosed with. Try again; it is a round trip.");
        }
    }
}
