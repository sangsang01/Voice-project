# Post-Merge Integration Task

Run this only after both agent branches pass their owned test suites. The integration owner resolves root workspace and lockfile changes; Agent 1 owns the final frontend wiring.

## Files

- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `apps/web/package.json`
- Modify: `apps/web/src/features/transcription/engineFactory.ts`
- Modify: `apps/web/src/features/transcription/TranscriptionAdapter.test.tsx`
- Modify: `README.md`

## Steps

- [ ] Merge `feature/browser-local-transcription` and `feature/google-streaming-fallback` into an integration branch without accepting edits across ownership boundaries.

- [ ] Add Agent 2's reported root scripts and workspace dependencies, then run `npm install` once so the integration owner alone resolves `package-lock.json`.

- [ ] Add the browser-safe cloud factory without importing the server entrypoint.

```ts
import { CloudEngineClient } from "@voice/google-transcription-engine/browser";
import { LocalWhisperEngine } from "@voice/local-whisper-engine";

export function createTranscriptionEngine(options: {
  kind: "local" | "cloud";
  cloudConsent: boolean;
  websocketUrl: string;
}) {
  if (options.kind === "local") return new LocalWhisperEngine();
  return new CloudEngineClient({
    cloudConsent: options.cloudConsent,
    websocketUrl: options.websocketUrl,
  });
}
```

- [ ] Extend `TranscriptionAdapter.test.tsx` to prove local remains the default, cloud construction fails without consent, consent creates only the browser client, and a cloud failure returns to a visible stopped/error state rather than silently uploading through another provider.

- [ ] Run a production web build and inspect its dependency output to confirm `@google-cloud/speech` and Node credential code are absent.

Run: `npm run build --workspace @voice/web`

Expected: exit 0 and no browser bundle reference to `@google-cloud/speech`.

- [ ] Run all verification commands.

```bash
npm test
npm run typecheck
npm run lint
npm run test:e2e --workspace @voice/web
npm run build --workspace @voice/web
```

Expected: every command exits 0.

- [ ] Perform local and consented-cloud manual sessions using the four-language fixture, verify Stop and Clear & Restart release every resource, and record latency/accuracy metrics in `README.md`.

- [ ] Commit the integration.

```bash
git add package.json package-lock.json apps/web README.md
git commit -m "feat: integrate local and cloud transcription engines"
```
