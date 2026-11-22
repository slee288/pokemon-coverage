import { Component, OnInit, OnDestroy } from '@angular/core';
import { calculateCoverage, Coverage } from './coverage';
import { Game, Generation, MoveOption, Pokedex, Pokemon, Resource, Species, evolutionParentIds, movesForGame, read } from './poke-api';

@Component({
  selector: 'app-root',
  standalone: true,
  templateUrl: './app.component.html'
})
export class AppComponent implements OnInit, OnDestroy {
  generations: Resource[] = [];
  games: Resource[] = [];
  dexes: Resource[] = [];
  generation = '';
  private generationId?: number;
  game = '';
  dex = '';
  roster: Resource[] = [];
  speciesUrl = '';
  pokemon?: Pokemon;
  availableMoves: MoveOption[] = [];
  moveSlots = ['', '', '', ''];
  coverage?: Coverage;
  spriteFailed = false;
  status = '';
  retry?: () => void;
  private request?: AbortController;

  ngOnInit() { this.loadGenerations(); }

  loadGenerations() {
    this.load('generations', async signal => {
      const page = await read<{ results: Resource[] }>('https://pokeapi.co/api/v2/generation/?limit=100', signal);
      return page.results;
    }, rows => this.generations = rows, () => this.loadGenerations());
  }

  selectGeneration(url: string) {
    this.clearRoster();
    this.generation = url;
    this.generationId = undefined;
    this.game = this.dex = '';
    this.games = [];
    this.dexes = [];
    this.load('games', signal => read<Generation>(url, signal), generation => {
      this.generationId = generation.id;
      this.games = generation.version_groups.filter(game => game.name !== 'colosseum' && game.name !== 'xd');
      if (!this.games.length) this.status = 'No games available for this generation.';
    }, () => this.selectGeneration(url));
  }

  selectGame(url: string) {
    this.clearRoster();
    this.game = url;
    this.dex = '';
    this.dexes = [];
    this.load('Pokédexes', async signal => (await read<Game>(url, signal)).pokedexes,
      rows => this.dexes = rows, () => this.selectGame(url));
  }

  private clearRoster() {
    this.roster = [];
    this.speciesUrl = '';
    this.clearPokemon();
  }

  private clearPokemon() {
    this.coverage = undefined;
    this.pokemon = undefined;
    this.availableMoves = [];
    this.moveSlots = ['', '', '', ''];
  }

  selectDex(url: string) {
    this.clearRoster();
    this.dex = url;
    const generationId = this.generationId;
    if (generationId === undefined) return;
    this.load('Pokémon', async signal => {
      const [dex, parents] = await Promise.all([
        read<Pokedex>(url, signal),
        evolutionParentIds(generationId, signal)
      ]);
      return dex.pokemon_entries
        .filter(entry => {
          const speciesId = Number(new URL(entry.pokemon_species.url).pathname.split('/').filter(Boolean).pop());
          return !parents.has(speciesId);
        })
        .sort((a, b) => a.entry_number - b.entry_number)
        .map(entry => entry.pokemon_species);
    }, rows => this.roster = rows, () => this.selectDex(url));
  }

  selectPokemon(url: string) {
    this.speciesUrl = url;
    this.clearPokemon();
    this.spriteFailed = false;
    this.load('Pokémon details', async signal => {
      const species = await read<Species>(url, signal);
      const variety = species.varieties.find(item => item.is_default);
      if (!variety) throw new Error('Missing default variety');
      return read<Pokemon>(variety.pokemon.url, signal);
    }, pokemon => {
      this.availableMoves = movesForGame(pokemon, this.game);
      this.pokemon = pokemon;
    }, () => this.selectPokemon(url));
  }

  selectMove(slot: number, url: string) {
    this.moveSlots[slot] = url;
    this.coverage = undefined;
    this.request?.abort();
    this.status = '';
    this.retry = undefined;
    const generation = this.generationId;
    if (!generation || this.moveSlots.includes('')) return;
    const selected = [...this.moveSlots];
    this.load('coverage', signal => calculateCoverage(selected, generation, signal),
      result => this.coverage = result, () => this.selectMove(slot, url));
  }

  private async load<T>(label: string, lookup: (signal: AbortSignal) => Promise<T>,
                        apply: (result: T) => void, retry: () => void) {
    this.request?.abort();
    const controller = new AbortController();
    this.request = controller;
    this.status = 'Loading ' + label + '…';
    this.retry = undefined;
    try {
      const result = await lookup(controller.signal);
      if (controller.signal.aborted) return;
      this.status = Array.isArray(result) && result.length === 0
        ? 'PokéAPI lists no ' + label + ' for this selection.' : '';
      apply(result);
    } catch {
      if (controller.signal.aborted) return;
      this.status = 'Could not load ' + label + '.';
      this.retry = retry;
    }
  }

  ngOnDestroy() { this.request?.abort(); }
}
