// Trylo Desktop Services — pet chat module factory.
//
// Wires the chat history store (TRYLO_APP_DATA_DIR-backed) to the chat
// command handler. The Desktop renderer drives each chat request through
// the `pet.chatHandle` host method, injecting the connection config per
// request (spec §6.4: 配置来源改为 Desktop settings JSON，经 request 参数注入).

import { createChatStore } from './chat-store.mjs';
import { createDesktopChatCommand } from './chat-command.mjs';

export function createPetChat({ appDataDir } = {}) {
  const store = createChatStore(appDataDir);
  const handle = createDesktopChatCommand({ store });
  return { store, handle };
}
