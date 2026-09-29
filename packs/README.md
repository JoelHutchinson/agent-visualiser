# Art packs

Licensed art packs you have bought go here. Everything in this folder except
this README is gitignored: these packs may be used in projects but not
redistributed, so they must never be committed or published in the npm package.

The app always works without them, using the bundled CC0 art.

## LimeZu — Modern Office (Revamped)

Used by the main app for the growing office (studio, office, mega building). Without it the app falls back to the CC0 tower view.

1. Buy it at <https://limezu.itch.io/modernoffice>.
2. Unzip `Modern_Office_Revamped_v1.2.zip` into a packs folder so this file exists:
   `<packs>/limezu-modern-office/2_Modern_Office_Black_Shadow/Modern_Office_Black_Shadow.png`
   where `<packs>` is `~/.agent-visualiser/packs` (or `--packs <dir>`, or `AGENT_VISUALISER_PACKS`,
   or this repo's `packs/` folder when running from source).
3. Run the app; the daemon serves the pack locally at `/packs`. The prototype at
   `proto/pixel/mega.html` (`npm run proto`) reads it from this repo folder.

Credit: "Modern Office" by LimeZu. The sprite coordinates the app uses are in
`web/src/office/packs/limezu.ts` (and `proto/pixel/packs/limezu.js`); neither contains art.
