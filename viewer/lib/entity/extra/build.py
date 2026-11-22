#!/usr/bin/env python3
"""Models for the mobs entities.json (1.16.4) doesn't have, so they stop showing as magenta boxes.

Geometry: *.geo.json here, copied from Mojang/bedrock-samples (resource_pack/models/entity/).
Textures: the Java client jar's, copied into public/textures/1.16.4/entity/ by --textures <jar>.
Mobs that reuse an older model only get a texture. Writes ../entities.extra.json.
Usage: python3 build.py [--textures path/to/client.jar]
"""
import copy, json, os, sys, zipfile

here = os.path.dirname(os.path.abspath(__file__))
own = {  # mob: (geo file, geometry identifier, texture under textures/entity/)
    'camel': ('camel', 'geometry.camel', 'camel/camel'),
    'goat': ('goat', 'geometry.goat', 'goat/goat'),
    'frog': ('frog', 'geometry.frog', 'frog/temperate_frog'),
    'tadpole': ('tadpole', 'geometry.tadpole', 'tadpole/tadpole'),
    'axolotl': ('axolotl', 'geometry.axolotl', 'axolotl/axolotl_lucy'),
    'allay': ('allay', 'geometry.allay', 'allay/allay'),
    'warden': ('warden', 'geometry.warden', 'warden/warden'),
    'sniffer': ('sniffer', 'geometry.sniffer', 'sniffer/sniffer'),
    'armadillo': ('armadillo', 'geometry.armadillo', 'armadillo'),
    'breeze': ('breeze', 'geometry.breeze', 'breeze/breeze'),
    'creaking': ('creaking', 'geometry.creaking', 'creaking/creaking'),
}
reuse = {  # mob: (model in entities.json, texture)
    'glow_squid': ('squid', 'squid/glow_squid'),
    'trader_llama': ('llama', 'llama/creamy'),
    'illusioner': ('evoker', 'illager/illusioner'),
    'giant': ('zombie', 'zombie/zombie'),
    'bogged': ('skeleton', 'skeleton/bogged'),
}

def geometry(file, ident):
    data = json.load(open(os.path.join(here, file + '.geo.json')))
    for g in data.get('minecraft:geometry', []):
        d = g['description']
        if d['identifier'] == ident:
            return {'texturewidth': d['texture_width'], 'textureheight': d['texture_height'], 'bones': g['bones']}
    raise KeyError(ident)

base = json.load(open(os.path.join(here, '..', 'entities.json')))
out = {}
for mob, (file, ident, tex) in own.items():
    out[mob] = {'identifier': 'minecraft:' + mob, 'textures': {'default': 'textures/entity/' + tex},
                'geometry': {'default': geometry(file, ident)}}
for mob, (model, tex) in reuse.items():
    out[mob] = {'identifier': 'minecraft:' + mob, 'textures': {'default': 'textures/entity/' + tex},
                'geometry': {'default': copy.deepcopy(base[model]['geometry']['default'])}}
json.dump(out, open(os.path.join(here, '..', 'entities.extra.json'), 'w'))

if '--textures' in sys.argv:
    jar = zipfile.ZipFile(sys.argv[sys.argv.index('--textures') + 1])
    dest = os.path.join(here, '..', '..', '..', '..', 'public', 'textures', '1.16.4')
    for entry in out.values():
        rel = entry['textures']['default'].removeprefix('textures/') + '.png'
        path = os.path.join(dest, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, 'wb') as f:
            f.write(jar.read('assets/minecraft/textures/' + rel))
print(len(out), 'models')
