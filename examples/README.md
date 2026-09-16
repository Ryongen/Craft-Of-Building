# Example builds

Build documents, not fixtures. A fixture is a build *plus what the game reported for it* and
lives in [`../fixtures`](../fixtures); these are just documents you can open in the app —
**File → Open** — to have something to look at without capturing your own character first.

`lagionaire.json` is a level 100 Sanguimancer. Its `skills[0].gemPercent` is 108, which the
validator flags as a warning rather than an error: `SkillGemData.perc` is a bare `int` that
nothing re-clamps on load, so a gem rolled before a rarity band changed keeps its number and the
game goes on using it. It is here deliberately — a document that exercises that path is worth
having.
