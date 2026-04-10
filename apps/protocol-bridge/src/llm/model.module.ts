import { Module } from "@nestjs/common"
import { DirectApiConfigService } from "./direct-api-config.service"
import { ModelRouterService } from "./model-router.service"

@Module({
  providers: [ModelRouterService, DirectApiConfigService],
  exports: [ModelRouterService, DirectApiConfigService],
})
export class ModelModule {}
