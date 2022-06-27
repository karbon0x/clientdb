import { sortBy } from "lodash";
import { IObservableArray, observable, runInAction } from "mobx";


import { EntityDefinition } from "./definition";
import { Entity } from "./entity";
import { FindInput } from "./find";
import {
  EntityQuery,
  EntityQuerySortFunction,
  EntityQuerySortInput,
  createEntityQuery,
  resolveSortInput,
} from "./query";
import { IndexableData, IndexableKey, QueryIndex, createQueryFieldIndex } from "./queryIndex";
import { EntityChangeSource } from "./types";
import { EventsEmmiter, createMobxAwareEventsEmmiter } from "./utils/eventManager";
import { cachedComputed } from ".";
import { MessageOrError, assert } from "../utils/assert";
import { areArraysShallowEqual } from "./utils/arrays";
import { createCleanupObject } from "./utils/cleanup";
import { deepMemoize } from "./utils/deepMap";
import { ClientDb } from "./db";

export interface EntityStoreFindMethods<Data, View> {
  query: (
    filter: FindInput<Data, View>,
    sort?: EntityQuerySortFunction<Data, View>
  ) => EntityQuery<Data, View>;

  sort: (sort: EntityQuerySortInput<Data, View>) => EntityQuery<Data, View>;
  findByUniqueIndex<K extends IndexableKey<Data & View>>(
    key: K,
    value: IndexableData<Data & View>[K]
  ): Entity<Data, View> | null;
  assertFindByUniqueIndex<K extends IndexableKey<Data & View>>(
    key: K,
    value: IndexableData<Data & View>[K]
  ): Entity<Data, View>;

  findById(id: string): Entity<Data, View> | null;
  assertFindById(id: string, error?: MessageOrError): Entity<Data, View>;
  removeById(id: string, source?: EntityChangeSource): boolean;

  find(filter: FindInput<Data, View>): Entity<Data, View>[];
  findFirst(filter: FindInput<Data, View>): Entity<Data, View> | null;
}

export interface EntityStore<Data, View> extends EntityStoreFindMethods<Data, View> {
  items: IObservableArray<Entity<Data, View>>;
  sortItems(items: Entity<Data, View>[]): Entity<Data, View>[];
  add(input: Entity<Data, View>, source?: EntityChangeSource): Entity<Data, View>;
  events: EntityStoreEventsEmmiter<Data, View>;
  definition: EntityDefinition<Data, View>;
  destroy: () => void;
  getKeyIndex<K extends IndexableKey<Data & View>>(key: K): QueryIndex<Data, View, K>;
}

export type EntityStoreFromDefinition<Definition extends EntityDefinition<unknown, unknown>> =
  Definition extends EntityDefinition<infer Data, infer View> ? EntityStore<Data, View> : never;

type EntityStoreEvents<Data, View> = {
  itemAdded: [Entity<Data, View>, EntityChangeSource];
  itemUpdated: [entity: Entity<Data, View>, dataBefore: Data, source: EntityChangeSource];
  itemWillUpdate: [entity: Entity<Data, View>, input: Partial<Data>, source: EntityChangeSource];
  itemRemoved: [Entity<Data, View>, EntityChangeSource];
};

export type EntityStoreEventsEmmiter<Data, View> = EventsEmmiter<EntityStoreEvents<Data, View>>;

/**
 * Store is inner 'registry' of all items of given entity. It is like 'raw' database with no extra logic (like syncing)
 */
export function createEntityStore<Data, View>(
  definition: EntityDefinition<Data, View>,
  db: ClientDb
): EntityStore<Data, View> {
  type StoreEntity = Entity<Data, View>;

  const { config } = definition;
  /**
   * Keep 2 'versions' of items list. Array and id<>item map for quick 'by id' access.
   */
  const items = observable.array<StoreEntity>([]);
  const itemsMap = observable.object<Record<string, Entity<Data, View>>>({});

  const getIsEntityAccessable =
    config.accessValidator &&
    cachedComputed(function getIsEntityAccessable(entity: StoreEntity) {
      return config.accessValidator!(entity, db);
    });

  const getRootSource = cachedComputed(
    function getSourceForQueryInput(): Entity<Data, View>[] {
      let output = items as StoreEntity[];

      if (config.accessValidator) {
        output = output.filter((entity) => getIsEntityAccessable!(entity));
      }

      return output;
    },
    { equals: areArraysShallowEqual }
  );

  const sortItems = cachedComputed((items: StoreEntity[]) => {
    if (!config.defaultSort) {
      return items;
    }

    return sortBy(items, config.defaultSort);
  });

  // Allow listening to CRUD updates in the store
  const events = createMobxAwareEventsEmmiter<EntityStoreEvents<Data, View>>(config.name);

  const queryIndexes = new Map<
    keyof Data | keyof View,
    QueryIndex<Data, View, IndexableKey<Data & View>>
  >();

  function getEntityId(entity: Entity<Data, View>) {
    const id = `${entity[config.keyField]}`;

    return id;
  }

  const cleanups = createCleanupObject();

  const createOrReuseQuery = deepMemoize(
    function createOrReuseQuery(filter?: FindInput<Data, View>, sort?: EntityQuerySortInput<Data, View>) {
      const resolvedSort = resolveSortInput(sort) ?? undefined;

      return createEntityQuery(getRootSource, { filter: filter, sort: resolvedSort }, store);
    },
    { checkEquality: true }
  );

  const findById = cachedComputed((id: string) => {
    const entity = itemsMap[id];

    if (!entity) return null;

    if (getIsEntityAccessable && !getIsEntityAccessable(entity)) return null;

    return entity;
  });

  const store: EntityStore<Data, View> = {
    definition,
    events,
    items,
    sortItems,
    getKeyIndex(key) {
      const existingIndex = queryIndexes.get(key);

      if (existingIndex) return existingIndex;

      const newIndex = createQueryFieldIndex(key, store);

      queryIndexes.set(key, newIndex);

      return newIndex;
    },
    add(entity, source = "user") {
      const id = getEntityId(entity);

      runInAction(() => {
        items.push(entity);
        itemsMap[id] = entity;
        events.emit("itemAdded", entity, source);
      });

      return entity;
    },
    findById(id) {
      return findById(id);
    },
    assertFindById(id, error) {
      const item = store.findById(id);

      assert(item, error ?? `No item found for id ${id}`);

      return item;
    },
    find(filter) {
      return store.query(filter).all;
    },
    findFirst(filter) {
      return store.query(filter).first;
    },
    findByUniqueIndex(key, value) {
      const results = store.getKeyIndex(key).find(value);

      if (!results.length) return null;

      if (results.length > 1) console.warn(`Store has multiple items for unique index value ${key as string}:${value as string}.`);

      const result = results[0];

      if (getIsEntityAccessable && !getIsEntityAccessable(result)) return null;

      return result;
    },
    assertFindByUniqueIndex(key, value) {
      const entity = store.findByUniqueIndex(key, value);

      assert(entity, `Assertion error for assertFindByUniqueIndex for key ${key as string} and value ${value as string}`);

      return entity;
    },
    removeById(id, source = "user") {
      const entity = itemsMap[id] ?? null;

      if (entity === null) return false;

      let didRemove = false;

      runInAction(() => {
        entity.cleanup.clean();
        didRemove = items.remove(entity);
        delete itemsMap[id];
        events.emit("itemRemoved", entity, source);
      });

      return didRemove;
    },
    query(filter, sort) {
      return createOrReuseQuery(filter, sort);
    },
    sort(sort) {
      return createOrReuseQuery(undefined, sort);
    },
    destroy() {
      runInAction(() => {
        cleanups.clean();
        queryIndexes.forEach((queryIndex) => {
          queryIndex.destroy();
        });
        events.destroy();
      });
    },
  };

  return store;
}
