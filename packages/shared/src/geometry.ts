/**
 * Normalized geometry shared by the CV surfaces. Coordinates are 0..1 in
 * the ANALYSIS frame with a top-left origin — never pixels of a local
 * file, never a crop path.
 */

/**
 * The rectangle of the analysis frame a planogram rack occupies. Frame
 * the rack tightly; leaving it out means the whole frame.
 *
 * Declared once here because the upload binding, the pretrained-vision
 * report and the admin web all used to spell out the same four numbers.
 */
export interface RackFrameRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}
