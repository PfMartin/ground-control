import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { ChatController } from './controller'
import './styles.css'

const controller = new ChatController()
createRoot(document.getElementById('root')!).render(<React.StrictMode><App controller={controller} /></React.StrictMode>)
