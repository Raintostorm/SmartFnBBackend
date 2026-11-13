import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { UsersModule } from '../users/users.module.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { JwtAuthGuard } from './guards/jwt-auth.guard.js';
import { RolesGuard } from './guards/roles.guard.js';
import { PasswordService } from './password.service.js';
import { PasswordResetController } from './password-reset.controller.js';
import { PasswordResetService } from './password-reset.service.js';
import { EmailModule } from '../email/email.module.js';
import { PasswordResetEvents } from './password-reset.events.js';
import { ProfileService } from './profile.service.js';

@Module({
  imports: [JwtModule.register({}), UsersModule, EmailModule],
  controllers: [AuthController, PasswordResetController],
  providers: [
    AuthService,
    PasswordService,
    PasswordResetService,
    PasswordResetEvents,
    ProfileService,
    JwtAuthGuard,
    RolesGuard,
    {
      provide: APP_GUARD,
      useExisting: JwtAuthGuard,
    },
    {
      provide: APP_GUARD,
      useExisting: RolesGuard,
    },
  ],
  exports: [AuthService, PasswordService, PasswordResetEvents, PasswordResetService],
})
export class AuthModule {}
