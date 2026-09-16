export { extract, forEachStatModifier, gearItemIds, SNAPSHOT_VERSION } from "./extract.js";
export type { Diagnostics, EntrySource, RegistryEntry, Snapshot } from "./extract.js";
export {
  ASSET_INDEX_VERSION,
  UNKNOWN_ICON,
  assetPath,
  extractAssets,
  isSafeAssetPath,
  resolveAsset,
} from "./assets.js";
export type { AssetIndex, AssetOptions, AssetResult, AssetSource } from "./assets.js";
export { itemIconPath, resolveItemIcons } from "./item-icons.js";
export type { ItemIconResult } from "./item-icons.js";
export { LocateError, fingerprintInstall, fingerprintsMatch, locateInstall } from "./locate.js";
export type { Install, InstallFingerprint, OpenLoaderPack } from "./locate.js";
export { parseLenient } from "./lenient-json.js";
export type { LenientParseResult, Repair } from "./lenient-json.js";
export { ZipArchive } from "./zip.js";
export type { ZipEntry } from "./zip.js";
