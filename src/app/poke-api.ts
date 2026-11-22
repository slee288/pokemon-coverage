export interface Resource { name: string; url: string }
export interface Generation { id: number; version_groups: Resource[] }
export interface Game { pokedexes: Resource[] }
export interface Pokedex {
  pokemon_entries: { entry_number: number; pokemon_species: Resource }[];
}
export interface Species {
  varieties: { is_default: boolean; pokemon: Resource }[];
}
export interface Pokemon {
  name: string;
  sprites: { front_default: string | null };
  moves: {
    move: Resource;
    version_group_details: { version_group: Resource; move_learn_method: Resource }[];
  }[];
}

export interface MoveOption {
  move: Resource;
  methods: string[];
}

const learnMethods = new Map([
  ['level-up', 'Level-up'], ['machine', 'Machine'], ['egg', 'Egg'], ['tutor', 'Tutor']
]);

export function movesForGame(pokemon: Pokemon, gameUrl: string): MoveOption[] {
  const options: MoveOption[] = [];
  for (const entry of pokemon.moves) {
    const methods = new Set<string>();
    for (const detail of entry.version_group_details) {
      const method = learnMethods.get(detail.move_learn_method.name);
      if (detail.version_group.url === gameUrl && method) methods.add(method);
    }
    if (methods.size) options.push({ move: entry.move, methods: [...methods] });
  }
  return options.sort((a, b) => a.move.name.localeCompare(b.move.name));
}

// Each evolved species names its parent. A parent with any known evolution
// by the selected generation is ineligible, even outside the regional dex.
const parentIdsByGeneration = new Map<number, Set<number>>();

export async function evolutionParentIds(generation: number, signal: AbortSignal): Promise<Set<number>> {
  const cached = parentIdsByGeneration.get(generation);
  if (cached) return cached;

  const query = `
    query EvolutionParents($generation: Int!) {
      parents: pokemonspecies(
        where: {
          generation_id: { _lte: $generation }
          evolves_from_species_id: { _is_null: false }
        }
        distinct_on: evolves_from_species_id
      ) {
        id: evolves_from_species_id
      }
    }`;
  const response = await fetch('https://graphql.pokeapi.co/v1beta2', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables: { generation } }),
    signal
  });
  if (!response.ok) throw new Error('Could not load evolution data');
  const result = await response.json() as {
    data?: { parents: { id: number }[] };
    errors?: unknown[];
  };
  if (result.errors?.length || !result.data) throw new Error('Incomplete evolution data');
  const ids = new Set(result.data.parents.map(parent => parent.id));
  parentIdsByGeneration.set(generation, ids);
  return ids;
}

export async function read<T>(url: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error('PokéAPI request failed');
  return response.json();
}
