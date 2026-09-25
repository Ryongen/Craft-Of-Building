# Craft of Building

A build planner for Craft to Exile 2.

Plan a character outside the game: spend your talent tree, pick a class and skills, set up
gear and omens, and watch what it does to your stat sheet and your damage. It models the
pack's real numbers, so what the planner shows you is what the game would show you.

**Try it in your browser: [ryongen.github.io/Craft-Of-Building](https://ryongen.github.io/Craft-Of-Building/)**

There is also a Windows desktop version on the [Releases](../../releases) page, as an
installer or a portable `.exe` you can run from anywhere. The two are the same planner — the
desktop one reads data straight from your own CTE2 install, so it always matches the pack
version you actually have.

## What you can do with it

The planner is organised as tabs, roughly in the order you'd use them:

- **Tree** — allocate the passive tree.
- **Classes** — your class, ascendancy and class points.
- **Skills** — spells and abilities, with their support gems and augments.
- **Items** — every gear slot, plus jewels and omens. You can build items by hand in the
  editor, or paste one in from the game.
- **Damage** — what your build actually does: hits, ailments, procs, and DPS across a full
  rotation, broken down so you can see where each number came from.
- **Defence** — resistances, mitigation, effective health pool, and the biggest hit you
  could survive per element.
- **Compare** — put two versions of a build side by side.
- **Config** — the situation you're being measured in: buffs, charges, target, map affixes.
- **Stats** — the whole character sheet, with a breakdown of what contributes to each line.

Builds are saved as you go, and you can export one to a file to back it up or share it.

## Bringing your character in from the game

Rather than re-entering a character by hand, you can export the one you're playing.

The repository includes a small client-side Forge mod, **Craft of Building Exporter**. Drop it
in your mods folder, and in game either press the *Export character* keybind or run:

```
/cobexport
```

That writes a `.json` file into a `cob-exports` folder inside your Minecraft instance. Open it
in the planner and you get your character as it stands — level, allocations, gear, gems and
auras — along with the stat sheet the game itself calculated, which the planner uses to check
its own numbers against reality.

The mod is client-side only. It reads data your client already has in order to draw your own
character screen, so it needs no permissions, no operator level, no server-side install, and it
sends nothing anywhere.

## Browser or desktop?

Mostly they're identical. The differences:

| | Desktop | Website |
| --- | --- | --- |
| Pack data | read from your own install | prebuilt, shipped with the site |
| Tells you when your pack is newer | yes | no — there's no install to compare against |
| Opening and saving builds | normal file dialogs, saves in place | saves in place on Chrome and Edge; elsewhere, saving downloads a copy |
| Recent builds | yes | Chrome and Edge only |

If your pack is a different version from the one the site was built with, you can hand the site
a `snapshot.json` exported by the desktop app on the **Data** tab and it will use that instead.
It stays in your browser; nothing is uploaded.

## Thanks

To LocalIdentity and everyone who keeps Path of Building going. This whole thing started as
"I wish CTE2 had one of those", and a lot of how it works is inspired from how PoB does it.

And to the testers who put up with the early versions, sent in builds that broke it, and
told me when the numbers looked wrong. It's a much better tool because of you.

## License

The source code is MIT licensed — see [LICENSE](LICENSE).

That covers the code only. Game data and art from Craft to Exile 2 and Mine and Slash belong to
their authors, and are not covered by it. [NOTICE](NOTICE) sets out what falls on which side of
that line.

Unofficial fan-made software, not affiliated with the Craft to Exile 2 or Mine and Slash teams.
Mine and Slash is by robertx22; Craft to Exile 2 is by the CTE team.
