// Start with calculateCoverage() at the bottom. It builds the table for one moveset.
// To trace a single matchup, follow its call to score(), then score()'s call to factor().
import { read, Resource } from './poke-api';

// These three interfaces describe the parts of the move and type API responses we read.
interface Move {
  name: string;
  type: Resource;
  damage_class: Resource;
}
interface Relations {
  double_damage_to: Resource[];
  half_damage_to: Resource[];
  no_damage_to: Resource[];
}
interface TypeInfo {
  damage_relations: Relations;
  past_damage_relations: { generation: Resource; damage_relations: Relations }[];
}

// One Matchup represents one defending type combination. Coverage groups those entries
// into the three table rows. The UI also displays notes or an empty-state message.
interface Matchup { defender: string; multiplier: number; winners: string }
export interface Coverage {
  rows: { label: string; entries: Matchup[] }[];
  notes: string[];
  message: string;
}

const moves = new Map<string, Move>();
const types = new Map<string, TypeInfo>();

// T is Move for the moves cache and TypeInfo for the types cache. The URL is the key.
// Only successful reads are saved. Requests still in flight use the caller's abort signal.
async function cached<T>(cache: Map<string, T>, url: string, signal: AbortSignal): Promise<T> {
  const hit = cache.get(url);
  if (hit) return hit;
  const result = await read<T>(url, signal);
  cache.set(url, result);
  return result;
}

// These ordinary defending types are shared by the standard battle charts.
function defendingTypes(generation: number): string[] {
  const names = 'normal fire water electric grass ice fighting poison ground flying psychic bug rock ghost dragon'.split(' ');
  if (generation >= 2) names.push('dark', 'steel');
  if (generation >= 6) names.push('fairy');
  return names.sort();
}

// Each historical chart gives the LAST generation it covers. Sorting by that cutoff
// lets find() pick the earliest chart that still covers our generation. For example,
// a cutoff of V applies when playing Gen III. Beyond all cutoffs we use the current chart.
function chartForGeneration(type: TypeInfo, generation: number): Relations {
  const history = type.past_damage_relations.map(entry => ({
    lastGeneration: Number(entry.generation.url.split('/').filter(Boolean).pop()),
    relations: entry.damage_relations
  }));
  history.sort((a, b) => a.lastGeneration - b.lastGeneration);
  return history.find(entry => generation <= entry.lastGeneration)?.relations ?? type.damage_relations;
}

// A move can deal damage and still lack a useful chart multiplier here. Hidden Power
// depends on build details; Seismic Toss deals level-based damage. Both get a UI note.
const conditional = new Set(['hidden-power', 'revelation-dance', 'aura-wheel', 'raging-bull',
  'ivy-cudgel', 'natural-gift', 'terrain-pulse']);
const specialDamage = new Set(['night-shade', 'seismic-toss', 'dragon-rage', 'sonic-boom', 'psywave',
  'super-fang', 'natures-madness', 'ruination', 'endeavor', 'final-gambit', 'counter', 'mirror-coat',
  'metal-burst', 'comeuppance', 'bide', 'fissure', 'guillotine', 'horn-drill', 'sheer-cold',
  'guardian-of-alola']);

// Resolve historical changes before looking up a chart. The internal value 'typeless'
// tells score() to return 1 without requesting a type chart from the API.
function effectiveMoveType(move: Move, generation: number): string {
  if (generation === 1 && ['bite', 'gust', 'karate-chop'].includes(move.name)) return 'normal';
  if (generation <= 4 && ['future-sight', 'doom-desire'].includes(move.name)) return 'typeless';
  if (generation >= 2 && move.name === 'struggle') return 'typeless';
  return move.type.name;
}

// One attacking type against ONE defending type. PokéAPI lists exceptions to neutral:
// for example, Water is in Fire's half_damage_to list, so Fire against Water returns 0.5.
function factor(chart: Relations, defender: string): number {
  if (chart.no_damage_to.some(type => type.name === defender)) return 0;
  if (chart.double_damage_to.some(type => type.name === defender)) return 2;
  if (chart.half_damage_to.some(type => type.name === defender)) return 0.5;
  return 1;
}

// One MOVE against the WHOLE defender. For Blaze Kick against Ghost/Water,
// multiply Fire vs Ghost (1) by Fire vs Water (0.5). This move scores 0.5.
// Named exceptions modify that calculation; Flying Press also uses the Flying chart.
function score(name: string, type: string, defenders: string[], charts: Map<string, Relations>): number {
  if (type === 'typeless') return 1;
  if (name === 'thousand-arrows' && defenders.includes('flying')) return 1;
  let result = 1;
  for (const defender of defenders) {
    if (name === 'freeze-dry' && defender === 'water') result *= 2;
    else if (name !== 'nihil-light' || defender !== 'fairy') result *= factor(charts.get(type)!, defender);
    if (name === 'flying-press') result *= factor(charts.get('flying')!, defender);
  }
  return result;
}

// Entry point called once all four slots are filled. The generation determines the
// defending types and charts; the game-specific learnset was already checked by the picker.
export async function calculateCoverage(urls: string[], generation: number, signal: AbortSignal): Promise<Coverage> {
  // 1. Resolve the four move URLs together. Changing a slot can reuse cached moves.
  const selected = await Promise.all(urls.map(url => cached(moves, url, signal)));
  const result: Coverage = { rows: [], notes: [], message: '' };

  // 2. Build the list we can score. Bulk Up occupies a slot but contributes no
  // attack. If every move is skipped, return a message before requesting any charts.
  const attacks: { name: string; type: string }[] = [];
  for (const move of selected) {
    if (move.damage_class.name === 'status') continue;
    const name = move.name.replace(/-/g, ' ');
    if (conditional.has(move.name)) result.notes.push(name + ' is conditional and excluded from scoring.');
    else if (specialDamage.has(move.name)) result.notes.push(name + ' uses special damage rules and is excluded from multiplier scoring.');
    else attacks.push({ name: move.name, type: effectiveMoveType(move, generation) });
  }
  if (!attacks.length) {
    result.message = result.notes.length ? 'No selected move has a scorable type multiplier.' : 'This moveset has no damaging moves.';
    return result;
  }

  // 3. Load one outbound chart per distinct attacking type. Two Fire moves share
  // one chart. Once this finishes, every remaining calculation runs locally.
  const needed = new Set(attacks.map(move => move.type));
  needed.delete('typeless');
  if (attacks.some(move => move.name === 'flying-press')) needed.add('flying');
  const charts = new Map<string, Relations>();
  await Promise.all([...needed].map(async type => {
    const data = await cached(types, 'https://pokeapi.co/api/v2/type/' + type + '/', signal);
    charts.set(type, chartForGeneration(data, generation));
  }));
  result.rows = ['Super-effective', 'Effective', 'Not-effective or No effect'].map(label => ({ label, entries: [] }));
  
  // 4. Enumerate single types and unordered pairs. With [Fire, Grass, Water],
  // Fire gets [Fire], [Fire, Grass], [Fire, Water]. Grass pairs only with Water
  // because [Grass, Fire] would repeat a matchup we've already counted.
  const defenders = defendingTypes(generation);
  for (const [index, first] of defenders.entries()) {
    const combinations = [[first], ...defenders.slice(index + 1).map(second => [first, second])];
    for (const combination of combinations) {
      // 5. Compare moves against this defender. For Hitmonlee against Ghost/Water,
      // High Jump Kick, Blaze Kick and Mega Kick score [0, 0.5, 0]. The best is
      // 0.5, so Blaze Kick goes in the bottom row. Keeping every score equal to
      // the best also preserves ties, including a tie at 0 when all hits are immune.
      const scores = attacks.map(move => score(move.name, move.type, combination, charts));
      const best = Math.max(...scores);
      const winners = attacks.filter((_, i) => scores[i] === best).map(move => move.name.replace(/-/g, ' '));
      const group = best > 1 ? 0 : best === 1 ? 1 : 2;
      result.rows[group].entries.push({ defender: combination.join(' / '), multiplier: best, winners: winners.join(', ') });
    }
  }
  return result;
}
