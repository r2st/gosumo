import { IsEmail, IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Look a customer up by the identifier a data subject actually has.
 *
 * Nobody making an access request knows their own client UUID; they know the
 * number they messaged from or the address they ordered with. Without this the
 * operator has to search the contacts screen first and copy an id, which is
 * both friction and a chance to export the wrong person.
 *
 * "At least one of the two" is enforced in the service, not here.
 * class-validator has no object-level rule, and the usual workaround — a
 * `@ValidateIf` on a phantom property — is satisfied by a caller who simply
 * sends that property, so the constraint it appears to express is one an empty
 * body can walk past.
 */
export class ResolveSubjectDto {
  @ApiPropertyOptional({ description: 'Customer phone, E.164', example: '+919876543210' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  phone?: string;

  @ApiPropertyOptional({ description: 'Customer email' })
  @IsOptional()
  @IsEmail()
  @MaxLength(320)
  email?: string;
}
