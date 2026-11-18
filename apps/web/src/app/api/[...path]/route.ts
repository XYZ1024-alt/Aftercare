import { consoleApi } from '../../../server/console.ts';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const handle = (request: Request): Promise<Response> => consoleApi().handle(request);

export { handle as DELETE, handle as GET, handle as POST };
