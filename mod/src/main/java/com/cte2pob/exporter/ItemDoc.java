package com.cte2pob.exporter;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.robertx22.mine_and_slash.database.data.omen.OmenData;
import com.robertx22.mine_and_slash.saveclasses.gearitem.gear_parts.AffixData;
import com.robertx22.mine_and_slash.saveclasses.jewel.JewelItemData;
import com.robertx22.mine_and_slash.saveclasses.skill_gem.SkillGemData;

import java.util.List;

/**
 * One saved item, as the build document spells it.
 *
 * <p>These mappings existed already, inline in {@link BuildExport}, because until now the only
 * way an item reached the planner was as part of a whole character. {@link ItemCopy} needs the
 * same mapping for one item held in one hand, and two copies of it would be two places for the
 * document shape to drift - so they live here and both callers use them.
 *
 * <p>Nothing here reads the game's databases or the player. A saved data class is already the
 * full description of the item: {@code AffixData} is {@code {id, rar, p}}, which is field for
 * field the {@code AffixRoll} the document wants. That is what makes a copied item exact where a
 * copied tooltip is a reconstruction.
 */
public final class ItemDoc {

    private ItemDoc() {
    }

    /** `AffixRoll[]` — the id, the tier band it rolled in, and the roll itself. */
    public static JsonArray affixArray(List<AffixData> affixes) {
        JsonArray array = new JsonArray();
        if (affixes == null) {
            return array;
        }
        for (AffixData affix : affixes) {
            if (affix == null || affix.isEmpty()) {
                continue;
            }
            JsonObject roll = new JsonObject();
            roll.addProperty("affixId", affix.id);
            roll.addProperty("tier", affix.rar);
            roll.addProperty("rollPercent", affix.p);
            array.add(roll);
        }
        return array;
    }

    /**
     * `BuildDoc.Jewel`.
     *
     * <p>`style` is the field that looks cosmetic and is not: it names the jewel (Meteorite,
     * Viridian or Stardust) and decides which affixes could have rolled on it, so a jewel
     * recorded without it reads back as a `str` one and a Stardust jewel's affixes look illegal.
     *
     * <p>`socket` is deliberately absent. The game's jewel inventory does not record which tree
     * cell a jewel sits in, and the engine does not need it - jewel stats apply wherever the
     * jewel is.
     */
    public static JsonObject jewel(JewelItemData jewel) {
        JsonObject out = new JsonObject();
        out.addProperty("rarity", jewel.rar);
        out.addProperty("itemLevel", jewel.lvl);
        out.addProperty("style", jewel.style);

        JsonArray affixes = affixArray(jewel.affixes);
        if (affixes.size() > 0) {
            out.add("affixes", affixes);
        }
        JsonArray corruptions = affixArray(jewel.cor);
        if (corruptions.size() > 0) {
            out.add("corruptions", corruptions);
        }

        if (jewel.uniq != null && jewel.uniq.id != null && !jewel.uniq.id.isEmpty()) {
            JsonObject unique = new JsonObject();
            unique.addProperty("id", jewel.uniq.id);
            unique.addProperty("rollPercent", jewel.uniq.perc);
            try {
                unique.addProperty("tier", jewel.uniq.getCraftedTier().ordinal());
            } catch (Exception ignored) {
                // The tier only decides how many of the unique's stats it carries; without it
                // the id and roll are still the two numbers that matter.
            }
            out.add("unique", unique);
        }

        if (jewel.auraStats != null && !jewel.auraStats.isEmpty()) {
            JsonArray auraStats = new JsonArray();
            for (var stat : jewel.auraStats) {
                if (stat == null || stat.affix == null || stat.affix.isEmpty()) {
                    continue;
                }
                JsonObject entry = new JsonObject();
                entry.addProperty("affixId", stat.affix);
                entry.addProperty("rollPercent", stat.perc);
                entry.addProperty("itemLevel", stat.lvl);
                auraStats.add(entry);
            }
            if (auraStats.size() > 0) {
                out.add("auraStats", auraStats);
            }
        }

        return out;
    }

    /** `BuildDoc.OmenSetup`. Its affixes do not roll - see the document's own note on `affixes`. */
    public static JsonObject omen(OmenData omen) {
        JsonObject out = new JsonObject();
        out.addProperty("id", omen.id);
        out.addProperty("itemLevel", omen.lvl);
        out.addProperty("rarity", omen.rar);

        if (omen.rarities != null && !omen.rarities.isEmpty()) {
            JsonObject requires = new JsonObject();
            omen.rarities.forEach((type, count) -> requires.addProperty(type.name(), count));
            out.add("requires", requires);
        }

        if (omen.slot_req != null && !omen.slot_req.isEmpty()) {
            JsonArray reqs = new JsonArray();
            for (OmenData.OmenSlotReq req : omen.slot_req) {
                JsonObject entry = new JsonObject();
                entry.addProperty("slot", req.slot);
                entry.addProperty("rarityType", req.rtype.name());
                reqs.add(entry);
            }
            out.add("slotRequirements", reqs);
        }

        JsonArray affixes = affixArray(omen.aff);
        if (affixes.size() > 0) {
            out.add("affixes", affixes);
        }

        return out;
    }

    /**
     * `BuildDoc.SkillSetup`, from a Skill gem item on its own.
     *
     * <p>No support gems: a gem in your hand is not linked into anything. Nor is `level` the
     * rank the character would cast it at - that is {@code InsertedSpell.rank}, which exists only
     * once the gem is on the bar and the class allocation has been read. What the item knows is
     * its own level, so that is what is written, and the planner treats it as a starting point
     * the same way it treats one typed in by hand.
     */
    public static JsonObject skill(SkillGemData gem) {
        JsonObject out = new JsonObject();
        out.addProperty("spellId", gem.id);
        out.addProperty("level", gem.getLevel());
        out.addProperty("gemPercent", gem.getStatPercent());
        return out;
    }

    /**
     * `BuildDoc.SupportLink` - a support gem, with the roll that gem itself carries.
     *
     * <p>The roll is the whole point of copying one rather than picking it from a list:
     * {@code SupportGem.GetAllStats(en, data)} reads {@code data.getStatPercent()} off this gem,
     * so two of the same support gem are two different modifiers. The rarity grants nothing on
     * its own but is the band that roll was drawn from, which is what lets the planner say
     * whether the roll is one the game could have produced.
     */
    public static JsonObject supportGem(SkillGemData gem) {
        JsonObject out = new JsonObject();
        out.addProperty("id", gem.id);
        out.addProperty("rollPercent", gem.getStatPercent());
        out.addProperty("rarity", gem.getRarityId());
        return out;
    }

    /** `BuildDoc.AuraSetup` - an Augment, which is a `SkillGemData` of type `AURA`. */
    public static JsonObject aura(SkillGemData gem) {
        JsonObject out = new JsonObject();
        out.addProperty("id", gem.id);
        out.addProperty("enabled", true);
        out.addProperty("rollPercent", gem.getStatPercent());
        out.addProperty("rarity", gem.getRarityId());
        return out;
    }
}
