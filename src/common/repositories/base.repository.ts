import { Model, Document } from 'mongoose';

export abstract class BaseRepository<T extends Document> {
  constructor(protected readonly model: Model<T>) {}

  async create(createEntityData: unknown): Promise<T> {
    const entity = new this.model(createEntityData);
    return await entity.save();
  }

  async findOne(
    filterQuery: Record<string, any>,
    projection?: any,
  ): Promise<T | null> {
    return this.model.findOne(filterQuery, projection).exec();
  }

  async findOneAndUpdate(
    filterQuery: Record<string, any>,
    updateQuery: Record<string, any>,
    options?: any,
  ): Promise<T | null> {
    return this.model
      .findOneAndUpdate(filterQuery, updateQuery, {
        new: true,
        ...options,
      })
      .exec() as unknown as Promise<T | null>;
  }

  async find(
    filterQuery: Record<string, any>,
    projection?: any,
    options?: any,
  ): Promise<T[]> {
    return this.model.find(filterQuery, projection, options).exec();
  }

  async updateOne(
    filterQuery: Record<string, any>,
    updateQuery: Record<string, any>,
    options?: any,
  ) {
    return this.model.updateOne(filterQuery, updateQuery, options).exec();
  }
}
