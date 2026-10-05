# Protected MindServer management — stage three

This source change adds an opt-in `management_auth_mode: "protected"` for verified launchers. It creates separate operator and read-only observer sessions at the supplied private session path. Bot credentials are generated per child spawn and sent over parent-child IPC; transport reconnect retains the spawn identity, while stop/replacement revokes it. Protected handlers derive sender identity from the authenticated socket. The observer receives named readiness only. UI settings updates are checked against `settings_spec.json` before the agent is restarted.

The operator and observer session file is hub-owned, mode 0600, under a mode 0700 directory, outside the static root. It is created without replacing an existing file and removed when the hub closes. Main and Python launch entry points request graceful shutdown on process signals. Tokens remain in memory or private IPC/session input; they are not written to settings, profiles, histories, manifests, or logs.

The synthetic Socket.IO fixture uses generated tokens and temporary files only. It covers anonymous rejection, operator and observer scope, no observer status/viewer-port broadcasts after bot login, settings schema rejection, sender spoofing, bot A-to-B chat, task acceptance ACKs, multiple-recipient task rejection, same-spawn reconnect, stale-spawn revocation, static/settings/log non-disclosure, graceful session removal, preservation of an existing sentinel session file, and refusal of a symlinked path into the static root. The process supervisor fixture checks IPC delivery, fresh credentials on restart, and revocation on stop.

Offline checks for this stage:

- `/home/akito/.cache/mindcraft-play/node-npm-cache/_npx/337e068089ca04e3/node_modules/node-linux-x64/bin/node tests/run-tests.cjs`
- `/home/akito/.cache/mindcraft-play/node-npm-cache/_npx/337e068089ca04e3/node_modules/node-linux-x64/bin/node --check main.js`
- `git diff --check`

The Node 20 full offline suite completed with exit 0. Its pass records include the authentication fixture, process supervisor fixture, hub lifecycle, reconnect/management, task shutdown/signals, SDK operation ownership, skills/navigation, and interaction/crafting/mining fixtures. `node --check main.js` and `git diff --check` also passed. The pushed full source SHA and matching eval export pin are recorded in the stage-three task report under `mindcraft-eval/docs/management-auth-stage3-20261005.md`. No live bot, gameplay, world, shared dependency, or existing credential was used for these checks.
