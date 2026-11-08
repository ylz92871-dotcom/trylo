import { createRoot } from 'react-dom/client'
import { ComputerPreviewWindow } from '../../src/components/chat/ComputerPreviewWindow'
import { setAppearance } from '../../src/settings/appearance-store'
import '../../src/styles/tokens.css'
import '../../src/styles/base.css'
import '../../src/styles/components/tool-preview.css'
import '../../src/styles/components/logo.css'
import '../../src/styles/components/computer-preview-window.css'
const theme = new URLSearchParams(location.search).get('theme')
setAppearance(theme === 'dark' ? 'dark' : 'light')
createRoot(document.getElementById('root')!).render(<ComputerPreviewWindow />)
