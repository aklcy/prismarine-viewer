function cleanupBlockName (name) {
  if (name.startsWith('block') || name.startsWith('minecraft:block')) return name.split('/')[1]
  return name
}

function getModel (name, blocksModels) {
  name = cleanupBlockName(name)
  const data = blocksModels[name]
  if (!data) {
    return null
  }

  let model = { textures: {}, elements: [], ao: true }

  for (const axis in ['x', 'y', 'z']) {
    if (axis in data) {
      model[axis] = data[axis]
    }
  }

  if (data.parent) {
    model = getModel(data.parent, blocksModels)
  }
  if (data.textures) {
    Object.assign(model.textures, JSON.parse(JSON.stringify(data.textures)))
  }
  if (data.elements) {
    model.elements = JSON.parse(JSON.stringify(data.elements))
  }
  if (data.ambientocclusion !== undefined) {
    model.ao = data.ambientocclusion
  }
  return model
}

function unwrapTexture (ref) {
  // 26.x wraps some model texture refs in objects ({ sprite, force_translucent, ... })
  return typeof ref === 'object' && ref !== null ? ref.sprite : ref
}

function prepareModel (model, texturesJson) {
  // resolve texture names eg west: #all -> blocks/stone
  for (const tex in model.textures) {
    let root = unwrapTexture(model.textures[tex])
    while (root.charAt(0) === '#') {
      root = unwrapTexture(model.textures[root.substr(1)])
    }
    model.textures[tex] = root
  }
  for (const tex in model.textures) {
    let name = model.textures[tex]
    name = cleanupBlockName(name)
    model.textures[tex] = texturesJson[name]
  }
  for (const elem of model.elements) {
    for (const sideName of Object.keys(elem.faces)) {
      const face = elem.faces[sideName]

      if (face.texture.charAt(0) === '#') {
        face.texture = JSON.parse(JSON.stringify(model.textures[face.texture.substr(1)]))
      } else if (
        !(cleanupBlockName(face.texture) in texturesJson) &&
        face.texture in model.textures
      ) {
        face.texture = JSON.parse(JSON.stringify(model.textures[face.texture]))
      } else {
        let name = face.texture
        name = cleanupBlockName(name)
        face.texture = JSON.parse(JSON.stringify(texturesJson[name]))
      }

      let uv = face.uv
      if (!uv) {
        const _from = elem.from
        const _to = elem.to

        // taken from https://github.com/DragonDev1906/Minecraft-Overviewer/
        uv = {
          north: [_to[0], 16 - _to[1], _from[0], 16 - _from[1]],
          east: [_from[2], 16 - _to[1], _to[2], 16 - _from[1]],
          south: [_from[0], 16 - _to[1], _to[0], 16 - _from[1]],
          west: [_from[2], 16 - _to[1], _to[2], 16 - _from[1]],
          up: [_from[0], _from[2], _to[0], _to[2]],
          down: [_to[0], _from[2], _from[0], _to[2]]
        }[sideName]
      }

      const su = (uv[2] - uv[0]) * face.texture.su / 16
      const sv = (uv[3] - uv[1]) * face.texture.sv / 16
      face.texture.bu = face.texture.u + 0.5 * face.texture.su
      face.texture.bv = face.texture.v + 0.5 * face.texture.sv
      face.texture.u += uv[0] * face.texture.su / 16
      face.texture.v += uv[1] * face.texture.sv / 16
      face.texture.su = su
      face.texture.sv = sv
    }
  }
}

function resolveModel (name, blocksModels, texturesJson) {
  const model = getModel(name, blocksModels)
  prepareModel(model, texturesJson.textures)
  return model
}

// Beds are block entities: the game ships an empty block model and draws them
// with an entity model over a 64x64 sheet (entity/bed/<color>). These models
// rebuild that geometry, facing north (head part toward north), with UVs in
// the sheet's 0-16 space (pixels / 4). Faces where head and foot meet are left out.
const px = (u0, v0, u1, v1) => [u0 / 4, v0 / 4, u1 / 4, v1 / 4]
function bedLeg (from, uv) {
  const face = { texture: '#bed', uv }
  return { from, to: [from[0] + 3, 3, from[2] + 3], faces: { north: face, east: face, south: face, west: face, down: face } }
}
const bedModels = {
  head: [
    {
      from: [0, 3, 0],
      to: [16, 9, 16],
      faces: {
        up: { texture: '#bed', uv: px(6, 6, 22, 22) },
        down: { texture: '#bed', uv: px(28, 6, 44, 22) },
        north: { texture: '#bed', uv: px(6, 0, 22, 6), rotation: 180 },
        west: { texture: '#bed', uv: px(0, 6, 6, 22), rotation: 90 },
        east: { texture: '#bed', uv: px(22, 6, 28, 22), rotation: 270 }
      }
    },
    bedLeg([0, 0, 0], px(53, 9, 56, 12)),
    bedLeg([13, 0, 0], px(53, 21, 56, 24))
  ],
  foot: [
    {
      from: [0, 3, 0],
      to: [16, 9, 16],
      faces: {
        up: { texture: '#bed', uv: px(6, 28, 22, 44) },
        down: { texture: '#bed', uv: px(28, 28, 44, 44) },
        south: { texture: '#bed', uv: px(22, 22, 38, 28), rotation: 180 },
        west: { texture: '#bed', uv: px(0, 28, 6, 44), rotation: 90 },
        east: { texture: '#bed', uv: px(22, 28, 28, 44), rotation: 270 }
      }
    },
    bedLeg([0, 0, 13], px(53, 3, 56, 6)),
    bedLeg([13, 0, 13], px(53, 15, 56, 18))
  ]
}
const facingY = { north: 0, east: 90, south: 180, west: 270 }

function addBeds (mcAssets, texturesJson) {
  for (const name of Object.keys(mcAssets.blocksStates)) {
    const color = name.match(/^(.+)_bed$/)?.[1]
    if (!color || !texturesJson[`entity/bed/${color}`]) continue
    const variants = {}
    for (const [part, elements] of Object.entries(bedModels)) {
      mcAssets.blocksModels[`${name}_${part}`] = { textures: { bed: `entity/bed/${color}`, particle: `entity/bed/${color}` }, elements }
      for (const [facing, y] of Object.entries(facingY)) {
        variants[`facing=${facing},part=${part}`] = { model: `${name}_${part}`, ...(y && { y }) }
      }
    }
    mcAssets.blocksStates[name] = { variants }
  }
}

function prepareBlocksStates (mcAssets, atlas) {
  addBeds(mcAssets, atlas.json.textures)
  const blocksStates = mcAssets.blocksStates
  mcAssets.blocksStates.missing_texture = {
    variants: {
      normal: {
        model: 'missing_texture'
      }
    }
  }
  mcAssets.blocksModels.missing_texture = {
    parent: 'block/cube_all',
    textures: {
      all: 'blocks/missing_texture'
    }
  }
  for (const block of Object.values(blocksStates)) {
    if (!block) continue
    if (block.variants) {
      for (const variant of Object.values(block.variants)) {
        if (variant instanceof Array) {
          for (const v of variant) {
            v.model = resolveModel(v.model, mcAssets.blocksModels, atlas.json)
          }
        } else {
          variant.model = resolveModel(variant.model, mcAssets.blocksModels, atlas.json)
        }
      }
    }
    if (block.multipart) {
      for (const variant of block.multipart) {
        if (variant.apply instanceof Array) {
          for (const v of variant.apply) {
            v.model = resolveModel(v.model, mcAssets.blocksModels, atlas.json)
          }
        } else {
          variant.apply.model = resolveModel(variant.apply.model, mcAssets.blocksModels, atlas.json)
        }
      }
    }
  }
  return blocksStates
}

module.exports = { prepareBlocksStates }
