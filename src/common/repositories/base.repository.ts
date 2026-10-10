import {
  Document,
  Model,
  ProjectionType,
  QueryFilter,
  QueryOptions,
  UpdateQuery,
  UpdateResult,
} from 'mongoose';

/**
 * Generic data access for one Mongoose model (constitution II): the only layer permitted to
 * touch a `Model`. Feature repositories extend it and add their own query methods, using
 * `.lean()` and a projection whenever a hydrated document is not needed (constitution VI).
 */
export abstract class BaseRepository<T extends Document> {
  constructor(protected readonly model: Model<T>) {}

  async create(createEntityData: Partial<T>): Promise<T> {
    const entity = new this.model(createEntityData);
    return entity.save();
  }

  async findOne(
    filterQuery: QueryFilter<T>,
    projection?: ProjectionType<T>,
  ): Promise<T | null> {
    return this.model.findOne(filterQuery, projection).exec();
  }

  async findOneAndUpdate(
    filterQuery: QueryFilter<T>,
    updateQuery: UpdateQuery<T>,
    options?: QueryOptions<T>,
  ): Promise<T | null> {
    return this.model
      .findOneAndUpdate(filterQuery, updateQuery, {
        new: true,
        ...options,
      })
      .exec();
  }

  async find(
    filterQuery: QueryFilter<T>,
    projection?: ProjectionType<T>,
    options?: QueryOptions<T>,
  ): Promise<T[]> {
    return this.model.find(filterQuery, projection, options).exec();
  }

  async updateOne(
    filterQuery: QueryFilter<T>,
    updateQuery: UpdateQuery<T>,
    options?: Parameters<Model<T>['updateOne']>[2],
  ): Promise<UpdateResult> {
    return this.model.updateOne(filterQuery, updateQuery, options).exec();
  }
}
