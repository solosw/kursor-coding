import { Module } from "@nestjs/common"
import { AdminController } from "./admin.controller"
import { DirectApiConfigService } from "../llm/direct-api-config.service"

@Module({
  controllers: [AdminController],
  providers: [DirectApiConfigService],
})
export class AdminModule {}
