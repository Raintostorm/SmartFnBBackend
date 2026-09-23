import type { INestApplicationContext } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import type { ServerOptions } from 'socket.io';

export class ConfiguredSocketIoAdapter extends IoAdapter {
  constructor(
    app: INestApplicationContext,
    private readonly path: string,
    private readonly origins: string[],
  ) {
    super(app);
  }

  createIOServer(port: number, options?: ServerOptions) {
    const allowAnyOrigin = this.origins.includes('*');
    return super.createIOServer(port, {
      ...options,
      path: this.path,
      cors: {
        origin: allowAnyOrigin ? true : this.origins,
        credentials: !allowAnyOrigin,
      },
    } as ServerOptions);
  }
}
