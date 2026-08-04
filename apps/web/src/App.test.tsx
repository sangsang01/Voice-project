import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { App } from './App'

describe('App', () => {
  it('renders the Earth Assistant console in standby', () => {
    render(<App />)

    expect(screen.getByRole('heading', { name: 'Earth Assistant' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Start' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Stop' })).toBeDisabled()
    expect(screen.getByRole('status')).toHaveTextContent('Standby')
    expect(screen.getByText('Press Start and speak — your words appear here.')).toBeInTheDocument()
  })

  it('switches the controls and status while a recording session is active', () => {
    render(<App />)

    fireEvent.click(screen.getByRole('button', { name: 'Start' }))

    expect(screen.getByRole('button', { name: 'Start' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Stop' })).toBeEnabled()
    expect(screen.getByRole('status')).toHaveTextContent('Listening')
  })

  it('offers the clear and restart control for a fresh transcription session', () => {
    render(<App />)

    expect(screen.getByRole('button', { name: 'Clear & Restart' })).toBeEnabled()
  })
})
