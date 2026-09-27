/**
 * Which skill's stat unit a skill-scoped breakdown reads.
 *
 * `DerivedBuild.skillBreakdown` is the *main* skill's, because that is the one the sidebar
 * resolves. The Stats tab can show any skill on the bar, and a breakdown opened from one of its
 * rows has to explain the number that row showed — so the tab provides the picked skill's unit
 * here and `StatBreakdown` prefers it. Nothing provides it elsewhere, and there the main skill
 * is still the answer.
 */

import { createContext } from "react";

import type { DerivedBuild } from "../../state/derived.js";

export type SkillSheet = {
  spellId: string;
  breakdown: DerivedBuild["breakdown"];
};

export const SkillSheetContext = createContext<SkillSheet | undefined>(undefined);
