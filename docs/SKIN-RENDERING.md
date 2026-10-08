# Skin rendering configuration

The MC server uses real TAB entries (`plugins/TAB/config.yml`,
`layout.enabled: false`). This avoids TAB 6.1.0 fake slot skin snapshots that
remain stale after a SkinsRestorer/disguise update. Name formatting, sorting,
header/footer and spectator permissions continue to use the existing settings.
The fixed 60-slot layout is retained in config but is inactive.

ItemsAdder's pack generation has both
`resource-pack.zip.emotes.legacy_shaders` and
`resource-pack.zip.emotes.1_21_5_to_1_21_9_shaders` disabled. The modern emote
method was already disabled. The old shader remaps ordinary 64×64 skin UVs;
the regenerated pack preserves normal player/head rendering instead. Shader
emote visuals are disabled; custom armor and text shaders remain enabled.

The current archive is published at:

`https://pack.nautilusuhc.com/generated.zip?v=97df9c175ed17072beaa5396ce3620dbaee4473c`

Its SHA-1 is `97df9c175ed17072beaa5396ce3620dbaee4473c` and size is 360,946
bytes. The user uploaded the corrected archive to Cloudflare and the MC URL
was restored to the same domain and file path. The `v` parameter uses the new
hash because the previous `v=2b2a918a80a01fa1ea5a31316b4aa5984d669f7e` URL
still returned the cached old archive after the upload. MC downloads and
ItemsAdder's URL validation confirm the new file.

The bot's fixed GET/HEAD endpoint remains available as a fallback at
`https://bot.nautilusuhc.com/resource-pack/97df9c175ed17072beaa5396ce3620dbaee4473c.zip`.
The MC server currently downloads from Cloudflare.

For a future pack regeneration: keep these shader options disabled, run
`iareload` then `iazip`, upload the generated archive to Cloudflare as
`generated.zip`, and update the MC URL's `v` parameter to its new SHA-1.
Download that public URL and verify its bytes/hash before reloading ItemsAdder.
Local `/iazip` alone does not publish the file to Cloudflare. If updating the
optional bot fallback, copy the archive into `resourcepacks/`, name it with
its SHA-1, update `src/resourcepack.js` and the byte test, verify tests, push
and wait for Dokploy. The bot checks its bundled file's hash on startup.

The MC backup directory is `/root/nautilus/backups/2026-10-08-skin-rendering/`:
`TAB-config.yml`, `ItemsAdder-config.yml`, and `output-generated.zip`.
To roll back, restore both config files and the archive to their original
locations, then run `tab reload` and `iareload`.

Validation: ItemsAdder generated the pack with shader validation enabled;
the four version-specific entity shaders no longer execute emote UV remapping
or set emote head/layer flags. A Minecraft 1.21.11 protocol probe receives its
own real, listed profile without the invisibility metadata bit. The public
download is checked byte-for-byte against the generated archive. A protocol
probe does not render the inventory; the final visual check uses the player's
actual client after downloading the new pack.
