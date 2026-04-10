import { Module } from "@nestjs/common"
import { UsageStatsModule } from "../../usage/usage-stats.module"
import { ModelModule } from "../model.module"
import { OpenaiCompatService } from "./openai-compat.service"

@Module({
  imports: [UsageStatsModule, ModelModule],
  providers: [OpenaiCompatService],
  exports: [OpenaiCompatService],
})
export class OpenaiCompatModule {}
