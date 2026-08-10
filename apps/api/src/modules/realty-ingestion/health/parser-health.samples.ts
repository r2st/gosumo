import { RealtyPortal } from '@gosumo/shared';
import type { PortalEmailInput } from '../portal-email.parser';

/**
 * The fields a healthy portal-email parse must recover. `phone` is always
 * required (a lead with no reachable contact is useless); the others are
 * expected for the given sample and their absence signals template drift.
 */
export type ExpectedField = 'phone' | 'name' | 'email' | 'listingRef';

export interface ParserSample {
  portal: RealtyPortal;
  /** A short label for this fixture (surfaced in the health report). */
  label: string;
  input: PortalEmailInput;
  /** Fields this known-good email should yield. */
  expect: ExpectedField[];
  /** The 10 significant digits the recovered phone must contain. */
  expectPhoneDigits: string;
}

/**
 * Known-good sample enquiry emails for each portal, mirroring the real templates
 * 99acres / MagicBricks / Housing.com send. The weekly health check re-parses
 * these; when a portal changes its layout the parser silently starts dropping
 * fields, which these fixtures catch before real leads are lost.
 */
export const PARSER_SAMPLES: ParserSample[] = [
  {
    portal: RealtyPortal.NINETYNINE_ACRES,
    label: '99acres — buyer response',
    input: {
      from: 'response@99acres.com',
      subject: 'New Response for your 2BHK listing',
      text: [
        'Dear Advertiser,',
        'You have received a new response on 99acres.',
        'Name: Rahul Sharma',
        'Phone: +91 98765 43210',
        'Email: rahul.sharma@example.com',
        'Property: 2BHK in Wakad, Pune (बुकिंग के लिए इच्छुक)',
        'Regards, 99acres Team',
      ].join('\n'),
    },
    expect: ['phone', 'name', 'email', 'listingRef'],
    expectPhoneDigits: '9876543210',
  },
  {
    portal: RealtyPortal.MAGICBRICKS,
    label: 'MagicBricks — new enquiry',
    input: {
      from: 'leads@magicbricks.com',
      subject: 'You have a new enquiry on MagicBricks',
      text: [
        'A buyer is interested in your property.',
        'Name - Priya Verma',
        'Mobile - 9823012345',
        'Email - priya.verma@example.com',
        'Interested in: Godrej Emerald, Thane West',
      ].join('\n'),
    },
    expect: ['phone', 'name', 'email', 'listingRef'],
    expectPhoneDigits: '9823012345',
  },
  {
    portal: RealtyPortal.HOUSING,
    label: 'Housing.com — new lead',
    input: {
      from: 'notifications@housing.com',
      subject: 'New lead from Housing.com',
      text: [
        'You have a new lead.',
        'Name: Amit Patel',
        'Contact Number: 088776 65544',
        'Email ID: amit.patel@example.com',
        'Regarding: 3BHK in Kalyan West',
      ].join('\n'),
    },
    expect: ['phone', 'name', 'email', 'listingRef'],
    expectPhoneDigits: '8877665544',
  },
];
