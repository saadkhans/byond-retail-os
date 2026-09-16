# @byond/cv-pipeline

Tier-1 tracking and tier-2 triggers for one camera. It proposes moments; the API
decides what they mean.

```bash
cp .env.example .env     # set CV_PIPELINE_API_TOKEN and CV_PIPELINE_ZONES
pnpm run start
```

Defaults need no camera, no ffmpeg and no model weights: the simulated frame
source synthesises frames and the frame-difference tracker measures them, so the
whole loop runs on a laptop and in CI.

Full documentation, including the tier boundaries, the debounce and rate-limit
rules, the backpressure policy and the source-secrecy contract, is in
[docs/cv/cv-pipeline-service.md](../../docs/cv/cv-pipeline-service.md).
