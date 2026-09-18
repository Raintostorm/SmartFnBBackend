import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { validateEnvironment } from './config/environment.validation.js';
import { PrismaModule } from './database/prisma.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { BranchesModule } from './modules/branches/branches.module.js';
import { EmployeesModule } from './modules/employees/employees.module.js';
import { AttendanceModule } from './modules/attendance/attendance.module.js';
import { MenuModule } from './modules/menu/menu.module.js';
import { OrdersModule } from './modules/orders/orders.module.js';
import { PaymentsModule } from './modules/payments/payments.module.js';
import { ReservationsModule } from './modules/reservations/reservations.module.js';
import { RolesModule } from './modules/roles/roles.module.js';
import { TablesModule } from './modules/tables/tables.module.js';
import { UsersModule } from './modules/users/users.module.js';
import { VouchersModule } from './modules/vouchers/vouchers.module.js';
import { PlatformAdminModule } from './modules/platform-admin/platform-admin.module.js';
import { ReportsModule } from './modules/reports/reports.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: validateEnvironment,
    }),
    PrismaModule,
    AuthModule,
    UsersModule,
    RolesModule,
    BranchesModule,
    EmployeesModule,
    TablesModule,
    ReservationsModule,
    MenuModule,
    OrdersModule,
    PaymentsModule,
    VouchersModule,
    AttendanceModule,
    PlatformAdminModule,
    ReportsModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
