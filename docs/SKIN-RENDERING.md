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

`https://bot.nautilusuhc.com/resource-pack/97df9c175ed17072beaa5396ce3620dbaee4473c.zip`

Its SHA-1 is `97df9c175ed17072beaa5396ce3620dbaee4473c` and size is 360,946
bytes. ItemsAdder's external-host URL must reference the same archive. The bot
serves this exact public file through GET/HEAD with immutable caching. Other
paths do not expose files. The earlier external URL served the old archive
even after local regeneration, so local `/iazip` alone was insufficient.

For a future pack regeneration: keep these shader options disabled, run
`iareload` then `iazip`, copy the generated archive into `resourcepacks/`,
name it with its SHA-1, update `src/resourcepack.js` and the byte test, verify
tests, push and wait for Dokploy. Download the public file and verify its hash
before changing the MC external URL and reloading ItemsAdder. The bot checks
the content hash on startup.

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
