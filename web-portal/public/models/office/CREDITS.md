# Office 3D Models — Credits & License

All models in this directory are **CC0 1.0 Universal (Public Domain)**. No
attribution is legally required; the credits below are provided as good practice.

## Furniture

| File            | id          | Source asset (Kenney "Furniture Kit") |
| --------------- | ----------- | ------------------------------------- |
| `desk.glb`      | `desk`      | `desk.obj`                            |
| `chair.glb`     | `chair`     | `chairDesk.obj`                       |
| `table.glb`     | `table`     | `tableRound.obj`                      |
| `couch.glb`     | `couch`     | `loungeSofaLong.obj`                  |
| `plant.glb`     | `plant`     | `pottedPlant.obj`                     |
| `bookshelf.glb` | `bookshelf` | `bookcaseOpen.obj`                    |
| `monitor.glb`   | `monitor`   | `computerScreen.obj`                  |
| `rug.glb`       | `rug`       | `rugRectangle.obj`                    |

- **Kit:** Furniture Kit by Kenney (kenney.nl) — CC0 1.0.
- **Obtained from:** Internet Archive mirror of the official CC0 pack
  (`https://archive.org/download/kenney_furniturePack/kenney_furniturePack.zip`).
- **Conversion:** The archive ships `.obj`/`.fbx`. Each model was converted to
  binary glTF (`.glb`) with `obj2gltf` (binary output). Source meshes and their
  flat per-material colors were preserved; no textures are referenced.

## Character

| File        | id      | Source asset (Kenney "Blocky Characters") |
| ----------- | ------- | ----------------------------------------- |
| `agent.glb` | `agent` | `character-a.glb` (GLB format, as shipped) |

- **Kit:** Blocky Characters by Kenney (kenney.nl) — CC0 1.0.
- **Obtained from:** OpenGameArt.org CC0 distribution of the official pack
  (`https://opengameart.org/sites/default/files/kenney_blocky-characters_2.0.zip`).
- **Conversion:** None — the kit ships ready-made glTF 2.0 `.glb` files; the
  `character-a` skin was copied verbatim as `agent.glb`.

## Verification

Every `.glb` here was checked to be a real binary glTF: the file begins with the
`glTF` magic (`0x67 0x6C 0x54 0x46`), declares glTF version 2, the header length
matches the file length, and the JSON chunk parses to valid `asset.version` 2.0.
No HTML error pages were kept.
