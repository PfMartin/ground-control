import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { ChatController } from './controller'
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/600.css'
import '@fontsource/jetbrains-mono/700.css'
import '@fontsource/space-grotesk/700.css'
import './styles.css'

const controller = new ChatController()
createRoot(document.getElementById('root')!).render(<React.StrictMode><App controller={controller} /></React.StrictMode>)
