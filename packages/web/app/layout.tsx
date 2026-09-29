import type { ReactNode } from 'react'
import { LiveRefresh } from '../components/LiveRefresh.js'
import { paletteCss } from '../lib/theme.js'
import './globals.css'

export const metadata = { title: 'knot' }

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <style>{paletteCss()}</style>
      </head>
      <body>
        {children}
        <LiveRefresh />
      </body>
    </html>
  )
}
