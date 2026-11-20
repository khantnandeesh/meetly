/**
 * Telling "you turned your camera off" from "the host did". Neither provider says who switched
 * a device off, so every control that toggles your own camera notes the moment here, and a
 * camera that goes off with no such note just before was switched off for you. The microphone
 * has the same arrangement next to its sounds (see noteOwnMicToggle in ./useSounds).
 */
const OWN_TOGGLE_MS = 1500;

let ownCameraToggleAt = -Infinity;

/** Call from every control that toggles your own camera. */
export function noteOwnCameraToggle(): void {
  ownCameraToggleAt = performance.now();
}

export function cameraToggledByYou(): boolean {
  return performance.now() - ownCameraToggleAt < OWN_TOGGLE_MS;
}
