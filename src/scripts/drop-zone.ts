/**
 * Behaviour for <DropZone>.
 *
 * The zone never reads a file. It validates, describes what it is holding, and
 * emits `dropzone:files` with a FileList, so the tool downstream owns the
 * bytes. That separation is what lets a 2GB USD stage and a 40KB image share
 * one control.
 *
 * The parts that are easy to get wrong, and are handled here once:
 *
 *   dragenter and dragleave fire for every child element the pointer crosses,
 *   so a naive listener flickers. A depth counter fixes it
 *   a dropped folder arrives as an entry with no type and no size, and reading
 *   it throws later rather than now, so it is rejected up front
 *   dragover must be cancelled or the browser navigates to the file
 *   the file input keeps a stale value, so re-picking the same file fires
 *   nothing unless it is cleared
 *   a screen reader gets no signal at all from a border colour changing
 */

const BOOTED = new WeakSet<HTMLElement>();

export interface DropZoneDetail {
  files: FileList;
  zone: HTMLElement;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** Does this file satisfy an accept attribute? Extensions and mime, same as the input would. */
function matchesAccept(file: File, accept: string): boolean {
  const patterns = accept
    .split(",")
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  if (!patterns.length) return true;

  const name = file.name.toLowerCase();
  const type = (file.type || "").toLowerCase();

  return patterns.some((pattern) => {
    if (pattern.startsWith(".")) return name.endsWith(pattern);
    if (pattern.endsWith("/*")) return type.startsWith(pattern.slice(0, -1));
    return type === pattern;
  });
}

/**
 * A dropped directory looks like a zero-type, zero-size file until you try to
 * read it. Catching it here turns a confusing failure later into a clear
 * refusal now.
 */
function looksLikeFolder(file: File): boolean {
  return file.size === 0 && file.type === "";
}

export function bootDropZones() {
  for (const zone of document.querySelectorAll<HTMLElement>("[data-drop-zone]")) {
    if (BOOTED.has(zone)) continue;
    BOOTED.add(zone);

    const input = zone.querySelector<HTMLInputElement>(".drop-zone-input");
    const meta = zone.querySelector<HTMLElement>("[data-drop-zone-meta]");
    const status = zone.querySelector<HTMLElement>("[data-drop-zone-status]");
    const label = zone.querySelector<HTMLElement>(".drop-zone-label");
    if (!input) continue;

    const accept = zone.dataset.accept || "";
    const maxBytes = Number(zone.dataset.maxBytes || 0);
    const restingLabel = label?.textContent ?? "";

    const say = (text: string) => {
      if (status) status.textContent = text;
    };

    const reject = (reason: string) => {
      zone.dataset.state = "error";
      if (meta) meta.textContent = reason;
      say(reason);
    };

    const accepted = (files: FileList) => {
      const list = [...files];
      zone.dataset.state = "loaded";
      if (label) {
        label.textContent = list.length === 1 ? list[0].name : `${list.length} files`;
      }
      if (meta) {
        meta.textContent = list.map((f) => formatBytes(f.size)).join(", ");
      }
      say(`${list.length === 1 ? list[0].name : `${list.length} files`} ready`);
      zone.dispatchEvent(
        new CustomEvent<DropZoneDetail>("dropzone:files", {
          detail: { files, zone },
          bubbles: true,
        })
      );
    };

    const offer = (files: FileList | null | undefined) => {
      if (!files || files.length === 0) return;

      for (const file of files) {
        if (looksLikeFolder(file)) return reject("That looks like a folder. Drop the file itself.");
        if (accept && !matchesAccept(file, accept)) {
          return reject(`${file.name} is not a type this accepts.`);
        }
        if (maxBytes && file.size > maxBytes) {
          return reject(`${file.name} is ${formatBytes(file.size)}, over the ${formatBytes(maxBytes)} limit.`);
        }
      }
      accepted(files);
    };

    // click and keyboard both mean the same thing: open the picker
    zone.addEventListener("click", (event) => {
      if (event.target === input) return;
      input.click();
    });

    zone.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      input.click();
    });

    input.addEventListener("change", () => {
      offer(input.files);
      // without this, choosing the same file twice in a row is silent
      input.value = "";
    });

    // dragenter and dragleave fire per child, so count depth rather than trust
    // the last event to be the truthful one
    let depth = 0;

    zone.addEventListener("dragenter", (event) => {
      event.preventDefault();
      depth++;
      zone.dataset.state = "dragging";
    });

    zone.addEventListener("dragover", (event) => {
      // without this the browser opens the file and the page is gone
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    });

    zone.addEventListener("dragleave", () => {
      depth = Math.max(0, depth - 1);
      if (depth === 0 && zone.dataset.state === "dragging") {
        zone.dataset.state = label?.textContent === restingLabel ? "empty" : "loaded";
      }
    });

    zone.addEventListener("drop", (event) => {
      event.preventDefault();
      depth = 0;
      offer(event.dataTransfer?.files);
    });

    if (zone.dataset.paste !== undefined) {
      zone.addEventListener("paste", (event) => {
        const files = (event as ClipboardEvent).clipboardData?.files;
        if (files && files.length) {
          event.preventDefault();
          offer(files);
        }
      });
    }
  }
}

/** Put a zone back to its resting state. For a tool's "clear" action. */
export function resetDropZone(zone: HTMLElement, label: string) {
  zone.dataset.state = "empty";
  const labelEl = zone.querySelector<HTMLElement>(".drop-zone-label");
  const meta = zone.querySelector<HTMLElement>("[data-drop-zone-meta]");
  if (labelEl) labelEl.textContent = label;
  if (meta) meta.textContent = "";
}
