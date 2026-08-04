import './app.css'
import { TranscriptionAdapter } from './features/transcription/TranscriptionAdapter'

export function App() {
  return <TranscriptionAdapter initialLanguages={['en-US']} />
}
