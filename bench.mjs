import { callFreeTier } from './scripts/lib/free-tier.mjs'
const texts = [
  'Craft a Bartering Station','Used to automatically &eTrade&r with nearby &6Piglins. Holds &6Gold ingots&r and output barter items.',
  'Collect 64 iron ingots from the Nether','Defeat the Ender Dragon and return to the Overworld',
  'Place a chest next to the furnace to start automation','Find the End Ship',
  "Claim the Ice Dragon's essence",'Unleash siege-level destruction',
  'Craft armor infused with the power of water','Defeat the shadow of the night',
  'Craft a weapon of darkness','Claim the weapon of silent death',
  'Defeat the undead sorcerer of chaos','Obtain a relic with powerful combat effects',
  'Craft a fire dragonsteel pickaxe','Obtain a relic with powerful combat effects',
  'Craft a simple necklace with defensive power','Find the Bandit Towers',
  'Craft a necklace of raw magical power','Defeat the guardian of the deep',
  'Craft a ring of ancient magic','Obtain a relic of the ancients',
  'Craft a weapon of pure light','Defeat the champion of light',
  'Collect 32 diamonds','Smelt 64 glass blocks',
  'Craft a full set of netherite armor','Defeat the Wither',
  'Build a beacon','Trade with a villager',
]
const times = []
for (let i = 0; i < 3; i++) {
  const t = Date.now()
  try {
    const out = await callFreeTier(texts)
    times.push(Date.now() - t)
    console.log(`#${i+1} ok ${Date.now()-t}ms missing=${out.filter(x=>x==null).length}`)
  } catch (e) { console.log(`#${i+1} FAIL ${Date.now()-t}ms ${e.message}`) }
  await new Promise(r => setTimeout(r, 8000))
}
if (times.length) console.log('median', times.sort((a,b)=>a-b)[Math.floor(times.length/2)], 'ms')
