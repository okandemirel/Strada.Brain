/**
 * Episode board → goal tree pairing (WEB-8).
 *
 * monitor-lifecycle re-roots a decomposed goal tree under its EPISODE id
 * (`ep-…`), so every card on that board carries the episode id as its rootId,
 * while goal storage only knows the goal tree's own root id. The runtime bridge
 * needs the pairing to apply a Kanban move made on an episode board; without it
 * the lookup missed and the move was dropped.
 *
 * The pairing is kept per workspace bus: the lifecycle and the bridge are both
 * built around the same bus, so neither needs a reference to the other. It is a
 * routing hint only; the bridge still requires the node to exist in the paired
 * goal tree. Bounded like the lifecycle's own episode map.
 */

const MAX_EPISODES = 200;
const MAX_GOAL_ROOTS_PER_EPISODE = 16;

export interface EpisodeGoalRoots {
  /** Record that `goalRootId`'s tree is shown on the board `episodeId`. */
  link(episodeId: string, goalRootId: string): void;
  /** The goal roots shown on `episodeId`'s board, most recent first. */
  goalRootsOf(episodeId: string): readonly string[];
}

function createEpisodeGoalRoots(): EpisodeGoalRoots {
  // Insertion order is recency: link() re-inserts, eviction drops the oldest.
  const byEpisode = new Map<string, string[]>();
  return {
    link(episodeId, goalRootId) {
      if (!episodeId || !goalRootId || episodeId === goalRootId) return;
      const roots = (byEpisode.get(episodeId) ?? []).filter((id) => id !== goalRootId);
      roots.unshift(goalRootId);
      roots.length = Math.min(roots.length, MAX_GOAL_ROOTS_PER_EPISODE);
      byEpisode.delete(episodeId);
      while (byEpisode.size >= MAX_EPISODES) {
        const oldest = byEpisode.keys().next().value;
        if (oldest === undefined) break;
        byEpisode.delete(oldest);
      }
      byEpisode.set(episodeId, roots);
    },
    goalRootsOf(episodeId) {
      return byEpisode.get(episodeId) ?? [];
    },
  };
}

const registries = new WeakMap<object, EpisodeGoalRoots>();

/** The pairing shared by everything built around `workspaceBus`. */
export function episodeGoalRootsFor(workspaceBus: object): EpisodeGoalRoots {
  let registry = registries.get(workspaceBus);
  if (!registry) {
    registry = createEpisodeGoalRoots();
    registries.set(workspaceBus, registry);
  }
  return registry;
}
