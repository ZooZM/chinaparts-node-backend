import { IsArray, IsInt, Min } from 'class-validator';

/** The body of `PUT /api/reels/:id/products`: the whole new list, in order. Empty clears it. */
export class SetProductsDto {
  // No maximum here: "too many" has its own error, TOO_MANY_PRODUCTS, from the service.
  @IsArray()
  @IsInt({ each: true })
  @Min(1, { each: true })
  productIds: number[];
}
