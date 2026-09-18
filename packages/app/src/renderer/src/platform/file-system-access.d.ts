/**
 * The parts of the File System Access API TypeScript's DOM lib does not declare.
 *
 * `FileSystemFileHandle` and `createWritable` are in `lib.dom.d.ts`; the pickers that hand you a
 * handle, and the permission methods that keep one usable across a reload, are not. Declared
 * here rather than pulling in `@types/wicg-file-system-access`, which would also redeclare the
 * halves that *are* in the lib and collide with them.
 *
 * Nothing in the desktop build touches these — `tsconfig.node.json` does not include this
 * directory — and every call site guards on `hasFileSystemAccess()` first, because Firefox and
 * Safari have none of it.
 */

interface FilePickerAcceptType {
  description?: string;
  accept: Record<string, string[]>;
}

interface OpenFilePickerOptions {
  types?: FilePickerAcceptType[];
  multiple?: boolean;
  excludeAcceptAllOption?: boolean;
  id?: string;
}

interface SaveFilePickerOptions {
  suggestedName?: string;
  types?: FilePickerAcceptType[];
  excludeAcceptAllOption?: boolean;
  id?: string;
}

interface FileSystemHandlePermissionDescriptor {
  mode?: "read" | "readwrite";
}

interface FileSystemHandle {
  queryPermission(descriptor?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>;
  requestPermission(descriptor?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>;
}

interface Window {
  showOpenFilePicker(options?: OpenFilePickerOptions): Promise<FileSystemFileHandle[]>;
  showSaveFilePicker(options?: SaveFilePickerOptions): Promise<FileSystemFileHandle>;
}
