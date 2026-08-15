Files modified to fix the Railway crash shown in logs.

Main fixes:
1. Initialize Baileys auth creds correctly with initAuthCreds() instead of allowing creds=null.
2. Replace the invalid custom key-store shape with a proper Baileys keys.get/keys.set store backed by MongoDB.
3. Prevent unpaired numbers from being marked enabled, so boot restore does not recreate broken sessions.
4. Skip restoring phones that have no valid saved Baileys session.
5. Mark phone enabled only after a real WhatsApp socket open event.
6. Remove duplicate pairing wait in Telegram flow.

Basic verification run:
- node --check src/models/Session.js
- node --check src/models/User.js
- node --check src/whatsapp/socket.js
- node --check src/telegram/bot.js
