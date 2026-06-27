import { Module } from "@nestjs/common";
import { AzureEmbeddingService } from "./azure-embedding.service";
import { AzureOpenAIService } from "./azure-openai.service";

@Module({
  providers: [AzureOpenAIService, AzureEmbeddingService],
  exports: [AzureOpenAIService, AzureEmbeddingService],
})
export class AzureModule {}
