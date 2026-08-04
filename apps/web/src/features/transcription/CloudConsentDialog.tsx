interface CloudConsentDialogProps { open: boolean; onCancel(): void; onConfirm(): void; }

export function CloudConsentDialog({ open, onCancel, onConfirm }: CloudConsentDialogProps) {
  if (!open) return null;
  return (
    <div aria-labelledby="cloud-consent-title" aria-modal="true" className="cloud-consent" role="dialog">
      <h2 id="cloud-consent-title">Use cloud transcription?</h2>
      <p>Cloud transcription sends audio off this device. Local transcription keeps audio in this browser.</p>
      <div>
        <button className="control-button" onClick={onCancel} type="button">Cancel</button>
        <button className="control-button" onClick={onConfirm} type="button">I consent to cloud transcription</button>
      </div>
    </div>
  );
}
