/**
 * DI tokens for the LOCAL vision runtime ports. The pretrained-vision
 * orchestration injects these tokens with PORT types only
 * (local-vision-runtime.port.ts); this module binds each token to its
 * concrete local adapter. Swapping the Python/Ultralytics worker for
 * another local runtime (ONNX-in-process, TensorRT, ...) rebinds a token
 * in local-vision-runtime.module.ts — the pretrained-vision service and
 * adapters never change and never import a runtime class.
 */
export const LOCAL_DETECTOR_RUNTIME = 'LOCAL_DETECTOR_RUNTIME';
