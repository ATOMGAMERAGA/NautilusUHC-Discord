# Skin and inventory rendering

The installed TAB 6.1.0 fake PlayerSlot retains a skin snapshot while the same
player occupies it. Later SkinsRestorer updates do not refresh that snapshot.
Use real TAB entries (`layout.enabled: false`), retaining name formatting,
sorting and header/footer. Existing fake layouts remain in config for rollback.

The served ItemsAdder archive contains emote vertex logic that remaps ordinary
64×64 skin UVs. Disable only `resource-pack.zip.emotes.legacy_shaders` and
`1_21_5_to_1_21_9_shaders`, then reload and regenerate. Verify the rebuilt
entity shaders preserve ordinary UVs and never assign emote head/layer flags.
Keep custom armor and text shader support.

The existing external host still serves the previous archive. Publish the new
archive through a fixed, content-addressed public GET/HEAD endpoint in the bot.
Do not expose arbitrary files or directory listings. Test bytes/hash, caching,
HEAD, rejected methods and unknown paths. Push to GitHub, observe Dokploy,
verify public downloaded bytes, then update/reload ItemsAdder's external URL.

Back up both MC configs and the previous archive before editing. Validate TAB
and MC profile packets after reload, plus normal bot health and reverse bridge.
A protocol probe cannot verify a client's rendered inventory screen; that
visual check requires the user's actual Minecraft client.
